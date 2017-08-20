"use strict";

const path = require("path");
const http = require("http");

const syslog = require("modern-syslog");

const express = require("express");
const morgan = require("morgan");
const compression = require("compression");
const responseTime = require("response-time");

const mongodb = require("mongodb").MongoClient;

const log = require("winston");
log.level = process.env.LOG_LEVEL || "debug";

const config = require("config").get("mqttdb");

const mqttdb_httpd_router = require("./mqttdb_httpd_router.js");
const spaceapi_router = require("./spaceapi_router.js");


// default config
const appPort = config.http.port || 3000;
const appHost = config.http.host || "127.0.0.1";

const dbURL = config.db.url || "mongodb://localhost/mqttdb";
const dbOptions = config.db.options || {};
const dbCollection = config.db.collection || "mqttdb";


log.info("Starting MQTT DB HTTP task");

// TODO: "Topology was destroyed" errors not handled, reconnect

mongodb.connect(dbURL, dbOptions)
.then((db) => new Promise((resolve, reject) => {
	log.info("MongoDB connected");

	// db.collection() requires a callback in strict-mode
	// TODO: think again. maybe there's a reason to it
	db.collection(dbCollection, {strict: true}, (err, coll) => {
		if (err) {
			reject(err);
		} else {
			resolve(coll);
		}
	});
}))
.then((coll) => {
	const app = express();

	app.disable("etag"); // use Last-Modified only
	app.disable("query parser");
	app.disable("x-powered-by");
	app.enable("strict routing");

	// record the response time
//	app.use(responseTime());

	// write access logs to syslog
/*
	app.use(morgan("combined", {
		stream: new syslog.Stream(syslog.level.LOG_INFO, syslog.facility.LOG_LOCAL4)
	}));
*/

	// compress some responses
	app.use(compression());

	// overlay static files
	app.use(express.static(path.join(__dirname, "..", "web", "dist"), {maxAge: "1h"}));

	// mount spaceapi router
	app.use("/spaceapi", spaceapi_router());

	// mount mqttdb router
	app.use("/", mqttdb_httpd_router(coll));

	// TODO: cluster IPC disconnect should kill the server(s) after timeout
	return Promise.all((Array.isArray(appHost) ? appHost : [appHost]).map((host) => new Promise((resolve) => {
		const server = http.createServer(app);

		server.on("listening", () => {
			resolve([null, server]);
		});

		server.on("error", (err) => {
			log.warn(`Error in listener ${host}:${appPort}`);
			log.warn(err);

			// TODO: think again. "error" could occur after "listening"
			resolve([err, server]);
		});

		return server.listen(appPort, host); // TODO: think again. maybe use resolve/reject, chain the promise and return map result later?
	})));
})
.then((results) => {
	const errors = results.filter(([err]) => err);
	const listeners = results.length - errors.length;

	errors.forEach(([, server]) => server.close());

	if (!listeners) {
		throw new Error("No active listeners");
	}

	log.debug(`${listeners} listener(s) started. ${errors.length} error(s)`);
})
.catch((err) => {
	log.error("Fatal error: ", err.toString());
	console.error(err);
	process.exit(1);
});

log.debug(`Worker #${process.id || 0} started with PID ${process.pid}`);
