"use strict";

const cluster = require("cluster");

if (cluster.isMaster) {
	const log = require("winston");
	log.level = process.env.LOG_LEVEL || "debug";

	const numWorkers = require("os").cpus().length;

	cluster.on("listening", (worker, address) => {
		log.debug(`Worker #${worker.id} listening on ${address.address}:${address.port}`);
	});

	cluster.on("exit", (worker, code, signal) => {
		const restart = 1000 + Math.ceil(Math.random() * 1000);
		log.warn(`Worker #${worker.id} (PID ${worker.process.pid}) died${(signal)?(` with signal ${signal}`):("")}. Restarting in ${restart}ms`);
		setTimeout(() => { cluster.fork(); }, restart);
	});

	for (var id = 1; id <= numWorkers; id++) {
		log.info(`Starting worker #${id}`);
		cluster.fork();
	}
} else {
	process.id = cluster.worker.id;
	require("./mqttdb_httpd.js");
}
