"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const express = require("express");
const morgan = require("morgan");

const mongodb = require("mongodb").MongoClient;
const JSONStream = require("JSONStream")

const debug = require("debug")(`mqttdb:httpd:${process.id || process.pid}`);
//const debug = console.log.bind(console);

const config = require("config").get("mqttdb");


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
	const router = express.Router();

	// no support for mqtt topics starting with combine/
	// no full support for mqtt topics ending in /past/nnn or /diff/nnn
	// /combine topic character set restricted to /[a-z0-9_/-]/i

	// /combine/topic1,topic2,... - generate JSON array ESI template
	// /topic                     - retrieve full data set
	// /topic/past/300000         - retrieve latest data
	// /topic/diff/1483228800000  - retrieve new data since timestamp


	// content is always JSON
	router.use((req, res, next) => {
		res.set("Content-Type", "application/json; charset=utf-8");
		next();
	});

	// generate ESI template
	router.get("/combine/*", (req, res) => {
		debug("Combine:", req.params[0]);

		// Cache-Control for the combined set. no Last-Modified
		// v-maxage controls varnish cache TTL for the template only
		res.set({
			"Surrogate-Control": "ESI/1.0",
			"Cache-Control": "max-age=10, v-maxage=3600, public"
		});

		// TODO: think again about ESI/XSS. allow only a restricted character set for now
		res.send(`[${req.params[0].split(",").map(key => `<esi:include src="/${key.replace(/[^a-z0-9_/-]+/gi, "")}"/>`).join(",")}]`);
	});

	// retrieve data
	router.get(["/:topic(*)/:cmd(diff|past)/:base([0-9]+)", "/:topic(*)"], (req, res, next) => {
		let query = {topic: req.params.topic};
		let base = undefined;

		switch (req.params.cmd) {
			case "diff":
				debug("Diff:", req.params.topic, req.params.base);
				base = new Date(parseInt(req.params.base));
				query.createdAt = {$gt: base};
				break;

			case "past":
				debug("Past:", req.params.topic, req.params.base);
				query.createdAt = {$gt: new Date(Date.now() - parseInt(req.params.base))};
				break;

			default:
				debug("Full:", query.topic);
				break;
		}

		let cursor = coll.find(query, {topic: 0, _id: 0}).sort({createdAt: 1});

		cursor.hasNext()
		.then((hasNext) => {
			if (hasNext) {
				// client loops over cached diffs, so the proxy can keep them
				res.set("Cache-Control", "max-age=120, s-maxage=300, public");

				// TODO: no Last-Modified header. maybe fetch last record first
				// or rewrite frontend to use reverse sort order

				// TODO: writing every record as separate HTTP chunk. performance?
				// maybe put a corking buffer between the pipes
				// varnish un-chunks & gzips the response, anyway

				cursor.stream({transform: doc => {
					try {
						return [doc.createdAt.getTime(), doc.message]
					} catch(err) {
						debug("Error in result stream:", err);
						return undefined;
					}
				}})
				.pipe(JSONStream.stringify())
				.pipe(res);
			} else {
				// debug("No results");

				// enable conditional requests on empty diffs
				// TODO: think again: why?
				// - conditional headers are bigger than []
				// + varnish can re-use the same cache object
				base && res.set("Last-Modified", base.toUTCString());

				// short negative-cache TTL
				res.set("Cache-Control", "s-maxage=10");
				res.send("[]");
			}
		})
		.catch(next);
	});

	router.use((err, req, res, next) => {
		debug("Error in response:", err);

		if (res.headersSent) {
			return next(err)
		}

		res.status(500).set("Cache-Control", "no-cache").json({error: err.toString()});
	});

	return router;
})
.then((router) => {
	const app = express();

	app.disable("etag"); // use Last-Modified only
	app.disable("query parser");
	app.disable("x-powered-by");
	app.enable("strict routing");

	// write access log
	// TODO: think about logrotate & make file path configurable
	app.use(morgan("combined", {
		stream: fs.createWriteStream(path.join(__dirname, "log", "access.log"), {flags: "a"})
	}));

	// handle Origin
	app.use((req, res, next) => {
		// caches must store variants based on request Origin
		// our response AC-Allow-Headers/Methods don't vary
		res.vary("Origin");

		// set CORS headers
		if (req.headers.origin) {
			// TODO: restrict if necessary. maybe check AC-Request-Headers
			// debug("Origin allowed:", req.headers.origin);

			res.set({
				"Access-Control-Allow-Origin": req.headers.origin,
				"Access-Control-Allow-Methods": "GET",
				"Access-Control-Allow-Headers": "DNT,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type",
				"Access-Control-Max-Age": "3600"
			});
		}

		next();
	});

	// mount mqttdb router
	app.use("/", router);

	// TODO: IPC disconnect should kill the server(s) after timeout
	return Promise.all((Array.isArray(appHost) ? appHost : [appHost]).map(host => new Promise((resolve, reject) => app.listen(appPort, host, resolve).on("error", reject))));

/*
	return Promise.all((Array.isArray(appHost) ? appHost : [appHost]).map(host => new Promise((resolve, reject) => {
		const server = http.createServer(app);

		server.on("listening", resolve);

		server.on("error", (err) => {
			if (err.code == "EADDRINUSE") {
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
	if (err.code == "EADDRINUSE") {
		// ignore EADDRINUSE
		debug(`Address ${err.address}:${err.port} already in use`);
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