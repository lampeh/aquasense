"use strict";

const mongodb = require("mongodb").MongoClient;
const mqtt = require("mqtt");

// const debug = require("debug")("mqttdb:writer");
const log = require("winston");
log.level = process.env.LOG_LEVEL || "debug";

const config = require("config").get("mqttdb");


// default config
const dbURL = config.db.url || "mongodb://localhost/mqttdb";
const dbOptions = config.db.options || {};
const dbCollection = config.db.collection || "mqttdb";

const mqttURL = config.mqtt.url || undefined;
const mqttPattern = config.mqtt.pattern || "#";
const mqttUser = config.mqtt.user || undefined;
const mqttPassword = config.mqtt.password || undefined;


log.info("Starting MQTT DB writer task");

mongodb.connect(dbURL, dbOptions)
.then((db) => new Promise((resolve, reject) => {
	// db.collection() requires a callback in strict-mode
	// TODO: think again. maybe there's a reason to it
	log.info("MongoDB connected");
	db.collection(dbCollection, {strict: true}, (err, coll) => {
		if (err) {
			reject(err);
		} else {
			coll.createIndex({topic: 1, createdAt: 1})
			.then((name) => {
				log.debug("Index created:", name);
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
		log.debug("Message:", topic, message);

		coll.insert({
			topic: topic,
			message: message,
			createdAt: new Date()
		})
		.catch((err) => {
			log.warn("Insert error:", err);
		});
	});

	client.on("reconnect", () => {
		log.debug(`Reconnecting to MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
	});

	client.on("error", (err) => {
		log.warn(`Error from MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
		// TODO: think again. "error" could occur after "connect"
		reject(err);
	});

	client.on("connect", () => {
		log.info(`MQTT connected${(mqttURL)?(` to ${mqttURL}`):("")}`);
		log.debug(`Subscribing patterns: ${mqttPattern}`);
		client.subscribe(mqttPattern, {qos: 2});
		resolve(client);
	});
}))
.then(() => {
	log.debug("MQTT client started");
})
.catch((err) => {
	log.error("Fatal error: ", err.toString());
	console.error(err);
	process.exit(1);
});
