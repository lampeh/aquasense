"use strict";

const express = require("express");
const cors = require("cors");

const JSONStream = require("JSONStream");

const debug = require("debug")(`mqttdb:httpd:router:${process.id || process.pid}`);

module.exports = ((coll) => {
	const router = express.Router();

	// /combine/topic1,topic2,...              - generate JSON array ESI template
	// /topic                                  - retrieve full data set
	// /topic/past/300000                      - retrieve latest data
	// /topic/diff/1483228800000               - retrieve new data since timestamp
	// /topic/diff/1483228800000/1483230800000 - retrieve data between timestamps

	// no support for mqtt topics starting with combine/
	// no full support for mqtt topics ending in /past/nnn or /diff/nnn
	// /combine topic character set restricted to /[a-z0-9_/-]/i

	// allow any Origin
	router.use(cors({origin: true}));

	// content is always JSON
	router.use((req, res, next) => {
		res.set("Content-Type", "application/json; charset=utf-8");
		next();
	});

	// generate ESI template
	router.get("/combine/*", (req, res) => {
		debug("Combine:", req.params[0]);

		// TODO: force compression even on short response
		// because compression middleware adds Vary: Accept-Encoding
		// without compressing the response, varnish un-gzips all sub-requests
		// see https://github.com/expressjs/compression#threshold

		// Cache-Control for the combined set. no Last-Modified
		// v-maxage controls varnish cache TTL for the template only
		res.set({
			"Surrogate-Control": "ESI/1.0",
			"Cache-Control": "max-age=10, v-maxage=3600, public"
		});

		// TODO: think again about ESI/XSS. allow only a restricted character set for now
		res.send(`[${req.params[0].split(",").map((key) => `<esi:include src="/${key.replace(/[^a-z0-9_/-]+/gi, "")}"/>`).join(",")}]`);
	});

	// retrieve data
	router.get([
		"/:topic(*)/:cmd(diff)/:base([0-9]+)/:end([0-9]+)",
		"/:topic(*)/:cmd(diff|past)/:base([0-9]+)",
		"/:topic(*)"
	], (req, res, next) => {
		const query = {topic: req.params.topic};

		switch (req.params.cmd) {
			case "diff":
				debug("Diff:", req.params.topic, req.params.base, req.params.end);
				query.createdAt = {$gt: new Date(parseInt(req.params.base))};
				if (req.params.end) {
					query.createdAt.$lt = new Date(parseInt(req.params.end));
				}
				break;

			case "past":
				debug("Past:", req.params.topic, req.params.base);
				query.createdAt = {$gt: new Date(Date.now() - parseInt(req.params.base))};
				break;

			default:
				debug("Full:", req.params.topic);
				break;
		}

		const cursor = coll.find(query, {topic: 0, _id: 0}).sort({createdAt: 1});

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

				const start = Date.now();
				let results = 0;

				cursor.stream({transform: (doc) => {
					results++;
					try {
						return [doc.createdAt.getTime(), doc.message];
					} catch(err) {
						debug("Error in result stream:", err);
						return undefined;
					}
				}})
				.pipe(JSONStream.stringify())
				.pipe(res)
				.on("finish", () => {
					debug(`${results} result(s) sent in ${Date.now() - start}ms`);
				});
			} else {
				// debug("No results");

				// enable conditional requests on empty diffs
				// TODO: think again: why?
				// - conditional headers are bigger than []
				// + varnish can re-use the same cache object
				res.set("ETag", "empty-json-array");

				// short negative-cache TTL
				res.set("Cache-Control", "s-maxage=10");
				res.send("[]");
			}
		})
		.catch(next);
	});

	// return errors as JSON
	router.use((err, req, res, next) => {
		debug("Error in response:", err);

		if (res.headersSent) {
			return next(err);
		}

		res.status(500).set("Cache-Control", "no-cache").json({error: err.toString()});
	});

	return router;
});
