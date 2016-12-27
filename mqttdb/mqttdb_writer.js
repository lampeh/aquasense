"use strict";

const mongodb = require("mongodb").MongoClient;
const mqtt = require("mqtt");

const debug = require("debug")("mqttdb:writer");

const config = require("config").get("mqttdb");


// default config
const dbURL = config.db.url || "mongodb://localhost/mqttdb";
const dbOptions = config.db.options || {};
const dbCollection = config.db.collection || "mqttdb";

const mqttURL = config.mqtt.url || undefined;
const mqttPattern = config.mqtt.pattern || "#";
const mqttUser = config.mqtt.user || undefined;
const mqttPassword = config.mqtt.password || undefined;


mongodb.connect(dbURL, dbOptions)
.then((db) => new Promise((resolve, reject) => {
	// db.collection() requires a callback in strict-mode
	// TODO: think again. maybe there's a reason to it
	debug("MongoDB connected");
	db.collection(dbCollection, {strict: true}, (err, coll) => {
		if (err) {
			reject(err);
		} else {
			coll.createIndex({topic: 1, createdAt: 1})
			.then((name) => {
				debug("Index created:", name);
				resolve(coll);
			})
			.catch(reject);
		}
	});
}))
.then((coll) => new Promise((resolve, reject) => {
	const client = mqtt.connect(mqttURL, {
		username: mqttUser,
		password: mqttPassword
	});

	client.on("message", (topic, msg) => {
		const message = msg.toString();
		debug("Message:", topic, message);

		coll.insert({
			topic: topic,
			message: message,
			createdAt: new Date()
		})
		.catch((err) => {
			debug("Insert error:", err);
		});
	});

	client.on("reconnect", () => {
		debug(`Reconnecting to MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
	});

	client.on("error", (err) => {
		debug(`Error from MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
		// TODO: think again. "error" could occur after "connect"
		reject(err);
	});

	client.on("connect", () => {
		debug(`MQTT connected${(mqttURL)?(` to ${mqttURL}`):("")}`);
		client.subscribe(mqttPattern, {qos: 2});
		resolve(client);
	});
}))
.then(() => {
	debug("MQTT client started");
})
.catch((err) => {
	debug("Fatal error");
	debug(err.toString());
	console.error(err);
	process.exit(1);
});
