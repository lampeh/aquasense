"use strict";

const spaceState = {
    "api": "0.13",
    "cache": {
        "schedule": "m.15"
    },
    "space": "Attraktor Makerspace",
    "url": "https://blog.attraktor.org/",
    "logo": "https://blog.attraktor.org/spaceapi/logo.png",
    "location": {
        "lat": 53.5498443,
        "lon": 9.946661,
        "address": "Eschelsweg 4, 22767 Hamburg, Germany"
    },
    "feeds": {
        "blog": {
            "url": "https://blog.attraktor.org/feed/",
            "type": "rss"
        },
        "wiki": {
            "url": "https://wiki.attraktor.org/Special:RecentChanges?feed=atom",
            "type": "atom"
        },
        "calendar": {
            "url": "https://wiki.attraktor.org/calendar.ics",
            "type": "ical"
        }
    },
    "issue_report_channels": [
        "issue_mail",
        "email"
    ],
    "contact": {
        "ml": "traktoristen@lists.attraktor.org",
        "twitter": "@attraktor_org",
        "google": {
            "plus": "104693613124183393398"
        },
        "facebook": "attraktoreV",
        "email": "office@attraktor.org",
        "issue_mail": "admin@attraktor.org"
    },
    "events": [
        { "name": "Hans Acker", "type": "fixed the SpaceApi pipeline", "timestamp": 1502969631, "extra": "Do we really need this?" }
    ]
};

const express = require("express");
const cors = require("cors");

const JSONStream = require("JSONStream");

const log = require("winston");
log.level = process.env.LOG_LEVEL || "debug";

const mqtt = require("mqtt");

const config = require("config").get("mqttdb");

// default config
const mqttURL = config.mqtt.url || undefined;
const mqttUser = config.mqtt.user || undefined;
const mqttPassword = config.mqtt.password || undefined;
const mqttPattern = [ "tuer/public/#", "power/average", "aqua/sensors/temp/#" ];


const lastState = {};

const client = mqtt.connect(mqttURL, {
	username: mqttUser,
	password: mqttPassword
});

client.on("connect", () => {
	log.debug(`MQTT connected${(mqttURL)?(` to ${mqttURL}`):("")}`);
	client.subscribe(mqttPattern, {qos: 2});
});

client.on("message", (topic, msg) => {
	lastState[topic] = msg.toString();
});

client.on("reconnect", () => {
	log.debug(`Reconnecting to MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
});

client.on("error", (err) => {
	log.debug(`Error from MQTT${(mqttURL)?(` at ${mqttURL}`):("")}`);
	// TODO: think again. "error" could occur after "connect"
	throw new Error(err);
});


module.exports = (() => {
	const router = express.Router();

	// allow any Origin
	router.use(cors({origin: true}));

	// content is always JSON
	router.use((req, res, next) => {
		res.set("Content-Type", "application/json; charset=utf-8");
		next();
	});

	router.get("/spaceapi.json", (req, res) => {
		spaceState.state = {
			"open": (lastState["tuer/public/state"] === "true"),
			"ext_open_detail": lastState["tuer/public/detail"],
			"message": lastState["tuer/public/message"],
			"lastchange": parseInt(lastState["tuer/public/lastchange"])
		};

		spaceState.sensors = {
			"temperature": [
	            { "location": "Outside", "unit": "°C", "value": parseFloat(lastState["aqua/sensors/temp/28ff6b1c91150371/mean"]) },
	            { "location": "Inside", "unit": "°C", "value": parseFloat(lastState["aqua/sensors/temp/28fc72cc03000030/mean"]) }
			],
			"power_consumption": [
	            { "location": "Mains", "unit": "W", "value": parseFloat(lastState["power/average"]) }
			]
		};
	
		res.set("Cache-Control", "s-maxage=120");
		res.send(JSON.stringify(spaceState, null, "\t"));
	});

	// return errors as JSON
	router.use((err, req, res, next) => {
		log.warn("Error in response:", err);
		if (res.headersSent) {
			return next(err);
		}

		res.status(500).set("Cache-Control", "no-cache").json({error: err.toString()});
	});

	return router;
});
