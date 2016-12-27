"use strict";

const fs = require("fs");
const path = require("path");

const express = require("express");
const morgan = require("morgan");
const compression = require("compression");
const responseTime = require("response-time");

const mongodb = require("mongodb").MongoClient;

const debug = require("debug")(`mqttdb:httpd:${process.id || process.pid}`);
//const debug = console.log.bind(console);

const config = require("config").get("mqttdb");

const mqttdb_httpd_router = require("./mqttdb_httpd_router.js");


// default config
const appPort = config.http.port || 3000;
const appHost = config.http.host || "127.0.0.1";

const dbURL = config.db.url || "mongodb://localhost/mqttdb";
const dbOptions = config.db.options || {};
const dbCollection = config.db.collection || "mqttdb";


// TODO: no longer required. maybe remove this
module.exports = () => {

// TODO: "Topology was destroyed" errors not handled, reconnect

mongodb.connect(dbURL, dbOptions)
.then((db) => new Promise((resolve, reject) => {
	debug("MongoDB connected");

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
	app.use(responseTime());

	// write access log
	// TODO: think about logrotate & make file path configurable
	app.use(morgan("combined", {
		stream: fs.createWriteStream(path.join(__dirname, "log", "access.log"), {flags: "a"})
	}));

	// compress some responses
	app.use(compression());

	// mount mqttdb router
	app.use("/", mqttdb_httpd_router(coll));

	// TODO: cluster IPC disconnect should kill the server(s) after timeout
	return Promise.all((Array.isArray(appHost) ? appHost : [appHost]).map((host) => new Promise((resolve, reject) => app.listen(appPort, host, resolve).on("error", reject))));

/*
	return Promise.all((Array.isArray(appHost) ? appHost : [appHost]).map(host => new Promise((resolve, reject) => {
		const server = http.createServer(app);

		server.on("listening", resolve);

		server.on("error", (err) => {
			if (err.code === "EADDRINUSE") {
				let retry = 1000 + Math.floor(Math.random() * 1000);
				debug(`Address ${host}:${appPort} already in use. Retrying in ${retry}ms`);
				setTimeout(() => {
					server.close(() => server.listen(appPort, host));
				}, retry);
			} else {
				// TODO: think again. "error" could occur after "listening"
				reject(err);
			}
		})

		return server.listen(appPort, host);
	})));
*/
})
.then(() => {
	debug("All listeners started");
})
.catch((err) => {
	if (err.code === "EADDRINUSE" || err.code === "EADDRNOTAVAIL") {
		debug(`Address ${err.address}:${err.port} not available`);
	} else {
		debug("Fatal error");
		debug(err.toString());
		console.error(err);
		process.exit(1);
	}
});

};

// run stand-alone if not require'd
if (require.main === module) {
	module.exports();
} else {
	debug(`Worker #${process.id || 0} started with PID ${process.pid}`);
}
