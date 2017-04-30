"use strict";

/*!
 *
 * Sensor Plot Frickelcode
 * must work on an old Apple TV
 *
 */

/*
 * external globals:
 * mqttdb_url = DB base URL
 * sensors = sensors to plot
 * expire = data window in ms
*/

(function($) {
$(document).ready(function() {
	// default Flot options for all plots
	var plotOptions = {
		xaxis: {
			mode: "time",
			timezone: "browser",
			timeformat: "%H:%M<br>%Y-%m-%d",
			tickFormatter: function (val, axis) {
				var d = new Date(val);
				var ret = "";

				if (d.getHours() < 10) {
					ret += "0";
				}
				ret += d.getHours() + ":";

				if (d.getMinutes() < 10) {
					ret += "0";
				}
				ret += d.getMinutes();

				if (d.getHours() === 0 && d.getMinutes() === 0) {
					ret += "<br><small>" + d.getFullYear() + "-";

					if ((d.getMonth()+1) < 10) {
						ret += "0";
					}
					ret += (d.getMonth()+1) + "-";

					if (d.getDate() < 10) {
						ret += "0";
					}
					ret += d.getDate();

					ret += "</small>";
				}

				return ret;
			}
		},
		yaxis: {
			position: "right",
			tickDecimals: 1,
			autoscaleMargin: 0.1,
			labelWidth: 60
		},
		series: {
			shadowSize: 0,
			lines: {
				show: true,
				lineWidth: 1,
				fill: false,
				zero: false,
				steps: false
			},
			points: {
				show: false,
				radius: 0.5,
				fill: true
			},
/*
			curvedLines: {
				active: false,
				apply: true,
				monotonicFit: false
			},
*/
		},
		colors: [
			"#AA44FF", "#FFAA44", "#AAFF44", "#FF44AA",
			"#44AAFF", "#FF44AA", "#44FFAA", "#FFFFAA"
		],
		grid: {
			borderWidth: 0,
			hoverable: true,
			autoHighlight: false,
			markings: [
				{ yaxis: { from: 20, to: 20}, lineWidth: 1.5, color: "rgba(255, 255, 255, 0.4)" },
				{ yaxis: { from: 0, to: 0}, lineWidth: 1.5, color: "rgba(0, 0, 255, 0.4)" },
			]
		},
		legend: {
			position: "nw",
			backgroundColor: "#000000",
			backgroundOpacity: 0.8,
			noColumns: 1
		}
	};

	$("#charts > .chart").each(function(i, container) {
		// TODO: config could be more generic
		var localOptions = {};
		var config = $(container).data();
		var configOptions = {
			yUnits: {
				yaxis: {
					tickFormatter: function(val, axis) {
						return ((val > 0)?((config["yPositive"] !== undefined) ? (config["yPositive"]) : ("+")):("")) + parseFloat(val).toFixed(axis.tickDecimals) + config["yUnits"];
					}
				}
			},

			yTicks: {
				yaxis: {
					ticks: config["yTicks"]
				}
			},

			xAxis: {
				xaxis: {
					show: config["xAxis"]
				}
			},

			yTickDecimals: {
				yaxis: {
					tickDecimals: config["yTickDecimals"]
				}
			},

			fill: {
				series: {
					lines: {
						fill: config["fill"]
					}
				}
			},

			steps: {
				series: {
					lines: {
						steps: config["steps"]
					}
				}
			},

			points: {
				series: {
					points: {
						show: config["points"]
					}
				}
			},

			legend: {
				legend: {
					show: config["legend"]
				}
			}
		};

		// merge localOptions
		$.each(configOptions, function(key, value) {
			if (config[key] !== undefined) {
				$.extend(true, localOptions, value);
			}
		});

		// create empty plot
		var plot = $.plot(container, [], $.extend(true, {}, plotOptions, localOptions));

		// series[] contains the plots, to be passed into plot.setData()
		// TODO: think again. passing custom field "url" into Flot may not always work
		var series = Object.keys(sensors[i]).map(function(key, idx) {
			return {
				id: key,
				color: sensors[i][key].color || idx,
				label: sensors[i][key].label || key,
				url: (sensors[i][key].url || key) + ((config["suffix"])?(config["suffix"]):("")),
				factor: (sensors[i][key].factor !== undefined) ? (sensors[i][key].factor) : (1)
			};
		});


		function updatePlot() {
			plot.setData(series);
			plot.setupGrid();
			plot.draw();
		}

		function addData(idx, record) {
			// TODO: maybe support single timestamp argument instead of array
			// destructuring arguments?

			if (!(record && record.length && record[0] !== undefined)) {
console.warn("Bug? Unusable input in addData");
				return;
			}

			// TODO: clarify trickery
			// the last data point is duplicated
			// and extended to current timestamp

			var data = series[idx].data;

			if (data && data.length) {
				// ignore same timestamp
				if (data[data.length-1][0] === record[0]) {
console.warn("Bug? Duplicate timestamp in addData");
					return;
				}

				// move last data point in time
				data[data.length-1][0] = record[0];

				if (record[1] !== undefined) {
					// overwrite duplicate value. real last point is at data.length-2
					// TODO: maybe verify that it really is?

					// watch out for references
					data[data.length-1][1] = record[1];

					// create new duplicate
					data.push(record);
				}

				// expire old data
				var cutoff = Date.now() - expire;
				var old = [];

				while (data.length && data[0][0] <= cutoff) {
					old = data.shift();
				}

				// re-add oldest data point with modified timestamp
				if (old.length) {
					old[0] = cutoff;

					// if data is now empty, duplicate initial data point
					// TODO: think about length == 1. should always be the same as old[1]
					if (!data.length) {
						data.unshift(old.slice());
					}

					data.unshift(old);
				}
			} else {
				// TODO: this should be dead code. is it?
				// updateGraphData never calls addData on empty data, right?
console.warn("Bug? Empty data encountered in addData");

				// no old data to move
				if (record[1] === undefined) {
					return;
				}

				// create data if it doesn't exist
				if (!data) {
					data = series[idx].data = [];
				}

				// initial data, duplicate first data point
				data.push(record);
				data.push(record.slice());
			}
		}

		// TODO: quick hack, refactor & move
		var maxLoops = 5; // limit initial catch-up requests

		$(container).addClass("loading");

		// TODO: this should generically support different formats
		// aqua and ntpi use different data backends
		(function updateGraphData(maxLoops) {
			// loop flag
			var more = false;

			// collect sensor update URLs
			// mqttdb supports /some/topic/(diff|past)/[0-9]+ to request partial data
			var urls = series.map(function(sensor) {
				var data = sensor.data;

				if (!(data && data.length)) {
					// get initial data set
					return sensor.url + "/past/" + expire;
				}

				// get updates since last data point
				// take timestamp from length-2 if last point is duplicate (which should always be true)

				var base;
				if (data.length > 1 && data[data.length-2][1] === data[data.length-1][1]) {
					base = data[data.length-2][0];
				} else {
					// TODO: this should be dead code
console.warn("Bug? No duplicate point at end of data in updateGraphData");
					base = data[data.length-1][0];
				}

				return sensor.url + "/diff/" + base;
			});

			// /combine/topic1,topic2,topic3 returns data as [topic1,topic2,topic3]
			// each topic contains [[ts, "value"],[ts, "value"],...]

			$.getJSON(mqttdb_url + "combine/" + urls.join(","))
				.done(function(data) {
					// combined data in series[] order
					if (data && data.length) {
						data.forEach(function(data, idx) {
							if (series[idx].data && series[idx].data.length) {
								// data points in chronologial order
								if (data && data.length) {
									// update data sequentially, convert all values to doubles
									// TODO: maybe make addData accept bulk updates
									data.forEach(function(record) {
										addData(idx, [record[0], parseFloat(record[1]) * series[idx].factor]);
									});

									// check for more recent updates
									more = true;
								} else {
									// no updates, move last data point to now()
									// TODO: think again, this relies on near-sync
									// between server and client clocks
									addData(idx, [Date.now()]);
								}
							} else if (data && data.length) {
								// initial import, duplicate last data point
								// don't use Date.now(). returned data may come from a cache,
								// the most recent data points might be missing
								data.push(data[data.length-1]);

								// convert all values to doubles
								series[idx].data = data.map(function(record) {
									return [record[0], parseFloat(record[1]) * series[idx].factor];
								});

								// request first diff
								more = true;
							}
						});

						// skip canvas update while looping
						if (!(maxLoops && more)) {
							updatePlot();
						}
					}
				})
				.always(function() {
					// walk quickly through initial (cached) diffs until result is empty
					if (maxLoops && more) {
						updateGraphData(--maxLoops);
					} else if (!isNaN($(container).data("reload"))) {
						setTimeout(updateGraphData, $(container).data("reload"));
						$(container).removeClass("loading");
					}
				});
		})(maxLoops);
	});
});
})(jQuery);
