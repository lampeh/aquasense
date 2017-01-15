"use strict";

const cluster = require("cluster");

if (cluster.isMaster) {
	const debug = require("debug")("mqttdb:httpd_cluster");
	const numWorkers = 2;
//	const numWorkers = require("os").cpus().length;

	cluster.on("listening", (worker, address) => {
		debug(`Worker #${worker.id} listening on ${address.address}:${address.port}`);
	});

	cluster.on("exit", (worker, code, signal) => {
		const restart = 1000 + Math.ceil(Math.random() * 1000);
		debug(`Worker #${worker.id} (PID ${worker.process.pid}) died${(signal)?(` with signal ${signal}`):("")}. Restarting in ${restart}ms`);
		setTimeout(() => { cluster.fork(); }, restart);
	});

	for (let id = 1; id <= numWorkers; id++) {
		debug(`Starting worker #${id}`);
		cluster.fork();
	}
} else {
	process.id = cluster.worker.id;
	require("./mqttdb_httpd.js")();
}
