var Service, Characteristic, Accessory, uuid;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.hap.Accessory;
	uuid = homebridge.hap.uuid;
	var exportedTypes = {
		Service: homebridge.hap.Service,
		Characteristic: homebridge.hap.Characteristic,
		Accessory: homebridge.hap.Accessory,
		PlatformAccessory: homebridge.platformAccessory,
		uuid: homebridge.hap.uuid
	};
	exportedTypes.AccessoryBase = require('./lib/accessory-base')(exportedTypes);
	exportedTypes.HubAccessoryBase = require('./lib/hub-accessory-base')(exportedTypes);
	exportedTypes.ActivityAccessory = require('./lib/activity-accessory')(exportedTypes);
	exportedTypes.Hub = require('./lib/hub')(exportedTypes);
	exportedTypes.HomePlatform = require('./lib/home-platform')(exportedTypes);

	homebridge.registerPlatform("homebridge-harmonyhub", "HarmonyHub", exportedTypes.HomePlatform, true);
};

var harmonyDiscover = require('harmonyhubjs-discover');
var harmony = require('harmonyhubjs-client');

var _harmonyHubPort = 61991;

var inherits = require('util').inherits;
var queue = require('queue');


function sortByKey(array, key) {
	return array.sort(function (a, b) {
		var x = a[key];
		var y = b[key];
		return ((x < y) ? -1 : ((x > y) ? 1 : 0));
	});
};


function LogitechHarmonyPlatform(log, config) {
	this.log = log;
	this.debug = log.debug;
	this.ip_address = config['ip_address'];
    this.email = config['email'];
    this.password = config['password'];
};


LogitechHarmonyPlatform.prototype = {

	accessories: function (callback) {
		var plat = this;
		var foundAccessories = [];
		var activityAccessories = [];
		var hub = null;
		var hubIP = null;
		var hubQueue = queue();
		hubQueue.concurrency = 1;

		// Get the first hub
		locateHub(function (err, client, clientIP) {
			if (err) throw err;

			plat.log("Fetching Logitech Harmony devices and activites...");

			hub = client;
			hubIP = clientIP;
			//getDevices(hub);
			getActivities();
		});

		// Find one Harmony remote hub (only support one for now)
		function locateHub(callback) {
			// Use the ip address in configuration if available
			if (plat.ip_address) {
				console.log("Using Logitech Harmony hub ip address from configuration");

				return createClient(plat.ip_address, callback)
			}

			plat.log("Searching for Logitech Harmony remote hubs...");

			// Discover the harmony hub with bonjour
			var discover = new harmonyDiscover(_harmonyHubPort);

			// TODO: Support update event with some way to add accessories
			// TODO: Have some kind of timeout with an error message. Right now this searches forever until it finds one hub.
			discover.on('online', function (hubInfo) {
				plat.log("Found Logitech Harmony remote hub: " + hubInfo.ip);

				// Stop looking for hubs once we find the first one
				// TODO: Support multiple hubs
				discover.stop();

				createClient(hubInfo.ip, callback);
			});

			// Start looking for hubs
			discover.start();
		}

		// Connect to a Harmony hub
		function createClient(ipAddress, callback) {
			plat.log("Connecting to Logitech Harmony remote hub...");
			harmony(plat.email, plat.password, ipAddress)
				.then(function (client) {
					plat.log("Connected to Logitech Harmony remote hub");
					callback(null, client, ipAddress);
				});
		}

		// Get Harmony Activities
		function getActivities() {
			plat.log("Fetching Logitech Harmony activities...");

			hub.getActivities()
				.then(function (activities) {
					plat.log("Found activities: \n" + activities.map(function (a) {
							return "\t" + a.label;
						}).join("\n"));

					hub.getCurrentActivity().then(function (currentActivity) {
						var actAccessories = [];
						var sArray = sortByKey(activities, "label");
						sArray.map(function (s) {
							var accessory = createActivityAccessory(s);
							if (accessory.id > 0) {
								accessory.updateActivityState(currentActivity);
								actAccessories.push(accessory);
								foundAccessories.push(accessory);
							}
						});
						activityAccessories = actAccessories;
						keepAliveRefreshLoop();
						callback(foundAccessories);
					}).catch(function (err) {
						plat.log('Unable to get current activity with error', err);
						throw err;
					});
				});
		}

		function createActivityAccessory(activity) {
			var accessory = new LogitechHarmonyActivityAccessory(plat.log, activity, changeCurrentActivity.bind(plat));
			return accessory;
		}

		var isChangingActivity = false;

		function changeCurrentActivity(nextActivity, callback) {
			if (!nextActivity) {
				nextActivity = '-1';
			}
			var handleErr = function (err) {
				isChangingActivity = false;
				if (callback) callback(err);
				refreshCurrentActivity();
			};
			plat.log('Queue activity to ' + nextActivity);
			executeOnHub(function (h, cb) {
				plat.log('Set activity to ' + nextActivity);
				isChangingActivity = true;
				var tout;
				h.startActivity(nextActivity)
					.then(function () {
						cb();
						isChangingActivity = false;
						if (tout) clearTimeout(tout);
						plat.log('Finished setting activity to ' + nextActivity);
						updateCurrentActivity(nextActivity);
						if (callback) callback(null, nextActivity);
					})
					.catch(function (err) {
						cb();
						if (tout) clearTimeout(tout);
						plat.log('Failed setting activity to ' + nextActivity + ' with error ' + err);
						handleErr(err);
					});

				// Gives the hub 2 seconds to change the activity (or fail) but otherwise assumes success
				// TODO: Temp work around. Needs to be replaced with a way to determine hub has at least started changing.
				tout = setTimeout(function () {
					tout = null;
					if (isChangingActivity) {
						plat.log('Setting activity to ' + nextActivity + ' took too long, assuming success.');
						updateCurrentActivity(nextActivity);
						if (callback) {
							callback(null, nextActivity);
							callback = null;
						}
					}
				}, 2000);
			}, function () {
				handleErr(new Error("Set activity failed too many times"));
			});
		}

		function updateCurrentActivity(currentActivity) {
			var actAccessories = activityAccessories;
			if (actAccessories instanceof Array) {
				actAccessories.map(function (a) {
					a.updateActivityState(currentActivity);
				});
			}
		}

		// prevent connection from closing
		function keepAliveRefreshLoop() {
			setTimeout(function () {
				setInterval(refreshCurrentActivity, 20000);
			}, 5000);
		}

		var isRefreshPending = false;
		function refreshCurrentActivity() {
			if (isRefreshPending) return;
			isRefreshPending = true;
			executeOnHub(function (h, cb) {
				isRefreshPending = false;
				plat.debug("Refreshing current activity");
				h.getCurrentActivity()
					.then(function (currentActivity) {
						cb();
						updateCurrentActivity(currentActivity);
					})
					.catch(function (error) {
						plat.log("Error refreshing status: " + error);
						cb(error)
					});
			}, refreshCurrentActivity);
		}

		function executeOnHub(func, funcMaxTimeout) {
			if (!func) return;
			hubQueue.push(function (cb) {
				var tout = setTimeout(function () {
					plat.log("Reconnecting to Hub " + hubIP);
					createClient(hubIP, function (err, newHub) {
						if (err) throw err;
						hub = newHub;
						cb();
						if (funcMaxTimeout) {
							funcMaxTimeout();
						}
					});
				}, 60000);
				func(hub, function () {
					clearTimeout(tout);
					cb();
				});
			});
			if (!hubQueue.running) {
				hubQueue.start();
			}
		}
	}
};

function LogitechHarmonyActivityAccessory(log, details, changeCurrentActivity) {
	this.log = log;
	this.id = details.id;
	this.name = details.label;
	this.isOn = false;
	this.changeCurrentActivity = changeCurrentActivity;
	Accessory.call(this, this.name, uuid.generate(this.id));
	var self = this;

	this.getService(Service.AccessoryInformation)
		.setCharacteristic(Characteristic.Manufacturer, "Logitech")
		.setCharacteristic(Characteristic.Model, "Harmony")
		// TODO: Add hub unique id to this for people with multiple hubs so that it is really a guid.
		.setCharacteristic(Characteristic.SerialNumber, this.id);

	this.addService(Service.Switch)
		.getCharacteristic(Characteristic.On)
		.on('get', function (callback) {
			// Refreshed automatically by platform
			callback(null, self.isOn);
		})
		.on('set', this.setPowerState.bind(this));

}

LogitechHarmonyActivityAccessory.prototype.getServices = function () {
	return this.services;
};

LogitechHarmonyActivityAccessory.prototype.updateActivityState = function (currentActivity) {
	this.isOn = (currentActivity === this.id);
	// Force get to trigger 'change' if needed
	this.getService(Service.Switch)
		.getCharacteristic(Characteristic.On)
		.getValue();
};

LogitechHarmonyActivityAccessory.prototype.setPowerState = function (state, callback) {
	this.changeCurrentActivity(state ? this.id : null, callback);
};
