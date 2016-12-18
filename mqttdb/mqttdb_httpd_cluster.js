"use strict";

const cluster = require("cluster");

if (cluster.isMaster) {
	const debug = require("debug")("mqttdb:httpd_cluster");
	const numWorkers = 2;
//	const numWorkers = require("os").cpus().length;

	let shutdown = false;

	cluster.on("listening", (worker, address) => {
		debug(`Worker #${worker.id} listening on ${address.address}:${address.port}`);
	});

	cluster.on("exit", (worker, code, signal) => {
		if (!shutdown) {
			let restart = 1000 + Math.ceil(Math.random() * 1000);
			debug(`Worker #${worker.id} (PID ${worker.process.pid}) died${(signal)?(` with signal ${signal}`):("")}. Restarting in ${restart}ms`);
			setTimeout(() => { cluster.fork() }, restart);
		}
	});

	for (let id = 1; id <= numWorkers; id++) {
		debug(`Starting worker #${id}`);
		cluster.fork();
	}

	process.on("SIGHUP", () => {
		debug("SIGHUP received. Reloading workers");
		Object.keys(cluster.workers).forEach(id => {
			debug(`Reloading worker #${id}`);
			cluster.workers[id].kill("SIGHUP");
		});
	});

	process.on("SIGTERM", () => {
		debug("SIGTERM received. Exiting");
		shutdown = true;

		debug("Disconnecting all workers");
		cluster.disconnect(process.exit);
	});

} else {
	process.id = cluster.worker.id;
	require("./mqttdb_httpd.js")();
}
