#include <ArduinoOTA.h>
#include <ESP8266httpUpdate.h>
#include <ESP8266WiFi.h>
#include <Gaussian.h>
#include <GaussianAverage.h>
#include <OneWire.h>
#include <PubSubClient.h>
#include <Ticker.h>

// aqua/sensors/temp/28ffd2339115019b - Temp 1
// aqua/sensors/temp/28ff35599115019b - Temp 2
// aqua/sensors/temp/28fc72cc03000030 - Temp Air
// aqua/sensors/temp/28ff6b1c91150371 - Temp Outdoor North


// TODO: think again. DS18B20 should never return this value
#define ESENSOR (0x8001)

const int dsPin = 5;
const int ledPin = 2;

const unsigned long serialRate = 115200;

const char *nodeName = "aquasense-01";

const char *otaHost = "fnordesp";
const char *otaPassword = "secret";

const char* wifiSSID = "Attraktor";
const char* wifiPassword = "secret";

const unsigned long wifiDelay = 500;
const unsigned long wifiTimeout = (30 * 1000) / wifiDelay;
const unsigned long wifiReconnectInterval = 5000;

const char* mqtt_server = "mqtt.aqua.attraktor.org";
//const char* mqtt_server = "192.168.0.198";
const int mqtt_port = 1883;
const unsigned long mqttReconnectInterval = 5000;

const char *mqttClientID = nodeName;
const char *mqttUser = "secret";
const char *mqttPassword = "secret";

const String logTopic = "aqua/log/aquasense";
const String statsTopic = "aqua/stats/aquasense/";
const String tempTopic = "aqua/sensors/temp/";

const String thisVersion = "255.0.0.5";
const char *dnsVersion = "aquasense.version.aqua.attraktor.org";
const char *updateURL = "http://aqua.attraktor.org/updates/aquasense/aquasense_flash.bin";

const unsigned long scanInterval = 3600 * 1000; // scan 1-wire for sensors
const unsigned long convertInterval = 4 * 1000; // issue Convert T command
const unsigned long readInterval = 10 * 1000; // read sensors
const unsigned long statsInterval = 600 * 1000; // log stats
const unsigned long updateCheckInterval = 86400 * 1000; // check published version number

const int dsMax = 4; // register at most dsMax sensors

const unsigned int sensorSamples = 200; // number of samples in GaussianAverage


volatile bool reboot = false;
volatile bool inOTA = false;

volatile bool doScan;
volatile bool doConvert;
volatile bool doRead;
volatile bool doStats;
volatile bool doUpdateCheck;

unsigned long mqttReconnectMillis = 0;
unsigned long wifiReconnectMillis = 0;

byte dsCount; // registered sensors
struct dsInfo {
  byte addr[8]; // binary 1-wire address
  char id[17]; // hex-char 1-wire address
  signed int lastResult;
  double mean;
  GaussianAverage *filter;
} dsInfos[dsMax];


OneWire ds(dsPin);

WiFiClient mqttWifi;
PubSubClient mqtt(mqttWifi);

Ticker scanTicker;
Ticker convertTicker;
Ticker readTicker;
Ticker statsTicker;
Ticker updateTicker;


void setup() {
  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, LOW);

  Serial.begin(serialRate);
  Serial.setDebugOutput(true);

  Serial.print(F("\r\nDS18B20 temperature sensor relay\r\n"));

  Serial.print(F("Connecting to WiFi."));
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSSID, wifiPassword);
  WiFi.setSleepMode(WIFI_LIGHT_SLEEP);

  unsigned long timeout = wifiTimeout;
  while (WiFi.status() != WL_CONNECTED && timeout--) {
    delay(wifiDelay);
    Serial.write('.');
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.print(F(" failed!\r\n"));
  } else {
    Serial.print(F(" ok\r\n"));
  }

  Serial.print(F("Initializing MQTT connection...\r\n"));
  mqtt.setServer(mqtt_server, mqtt_port);
  mqtt.setCallback(mqttCallback);

//  scanTicker.attach_ms(scanInterval, []() { doScan = true; });
  doScan = true;

  convertTicker.attach_ms(convertInterval, []() { doConvert = true; });
  doConvert = true;

  readTicker.attach_ms(readInterval, []() { doRead = true; });
  doRead = false; // skip first interval

  statsTicker.attach_ms(statsInterval, []() { doStats = true; });
  doStats = true;

  updateTicker.attach_ms(updateCheckInterval, []() { doUpdateCheck = true; });
  doUpdateCheck = true;

  setupOTA();

  digitalWrite(ledPin, HIGH);
}

void loop() {
  ArduinoOTA.handle();

  if (inOTA) {
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    unsigned long currentMillis = millis();

    if (diffMillis(wifiReconnectMillis, currentMillis) >= wifiReconnectInterval) {
      wifiReconnectMillis = currentMillis;
      Serial.print(F("Reconnecting to WiFi...\r\n"));
      WiFi.mode(WIFI_STA);
      WiFi.begin(wifiSSID, wifiPassword);
      yield();
    }
  }

  if (!mqtt.connected()) {
    unsigned long currentMillis = millis();

    if (diffMillis(mqttReconnectMillis, currentMillis) >= mqttReconnectInterval) {
      mqttReconnectMillis = currentMillis;
      digitalWrite(ledPin, LOW);

      Serial.print(F("Connecting to MQTT server... "));
      if (!mqtt.connect(mqttClientID, mqttUser, mqttPassword, logTopic.c_str(), 1, 0, "gone")) {
        Serial.print(F("failed!\r\n"));
      } else {
        Serial.print(F("ok\r\n"));
        mqtt.subscribe("aqua/cmd/aquasense/#");
        mqtt.publish(logTopic.c_str(), "reconnected", false);
      }

      digitalWrite(ledPin, HIGH);
    }
  }

  mqtt.loop();

  if (doScan) {
    dsCount = scan1Wire(dsInfos, dsMax);
    doScan = false;
  }

  if (doRead) {
    readAllSensors();
    doRead = false;
  }

  if (doConvert) {
    // issue Convert T command to all sensors
    ds.reset();
    ds.write(0xCC);
    ds.write(0x44);
    doConvert = false;
  }

  if (doStats) {
    mqttPublish(statsTopic + String("numsensors"), String(dsCount), false);
    mqttPublish(statsTopic + String("heap"), String(ESP.getFreeHeap()), false);
    mqttPublish(statsTopic + String("cycles"), String(ESP.getCycleCount()), false);
    doStats = false;
  }

  if (doUpdateCheck) {
	// horribly insecure HTTP update. for emergency use only
	// TODO: use HTTPS, verify image
    mqttPublish(logTopic, "update check", false);
    if (checkVersion()) {
      mqttPublish(logTopic, "update available", false);
      t_httpUpdate_return ret = ESPhttpUpdate.update(updateURL);

      switch(ret) {
          case HTTP_UPDATE_FAILED:
              mqttPublish(logTopic, "update failed", false);
              Serial.printf("HTTP_UPDATE_FAILD Error (%d): %s", ESPhttpUpdate.getLastError(), ESPhttpUpdate.getLastErrorString().c_str());
              break;

          case HTTP_UPDATE_NO_UPDATES:
              mqttPublish(logTopic, "update not an update", false);
              Serial.print(F("HTTP_UPDATE_NO_UPDATES\r\n"));
              break;

          case HTTP_UPDATE_OK:
              mqttPublish(logTopic, "update OK", false);
              Serial.print(F("HTTP_UPDATE_OK\r\n"));
              reboot = true;
              break;
      }
    }
    doUpdateCheck = false;
  }

  if (reboot) {
    mqttPublish(logTopic, "reboot requested", false);
    ESP.restart();
  }
}

bool checkVersion() {
  IPAddress newVersionIP;
  WiFi.hostByName(dnsVersion, newVersionIP);
  String newVersion = newVersionIP.toString();
  mqttPublish(logTopic, newVersion, false);
  return (newVersion > thisVersion);
}

bool mqttPublish(String topic, String payload, const bool retained) {
  return mqttPublish(topic.c_str(), payload.c_str(), retained);
}

bool mqttPublish(const char *const __restrict topic, const char *const __restrict payload, const bool retained) {
  if (!mqtt.connected()) {
    return false;
  }

  digitalWrite(ledPin, LOW);
  bool result = mqtt.publish(topic, payload, retained);
  digitalWrite(ledPin, HIGH);

  return result;
}

void mqttCallback(const char *const __restrict topic, const byte *const __restrict payload, const unsigned int length) {
  Serial.print(F("MQTT message received: "));
  Serial.print(topic);
  Serial.write(' ');
  Serial.print((char *)payload);
  Serial.print(F("\r\n"));
    
  if (!strcmp(topic, "aqua/cmd/aquasense/reboot")) {
    if (!strncmp((char *)payload, "Lc9Jd65y6u74lNocw", 17)) {
      reboot = true;
    }
  } else if (!strcmp(topic, "aqua/cmd/aquasense/update")) {
    if (!strncmp((char *)payload, "Lc9Jd65y6u74lNocw", 17)) {
      doUpdateCheck = true;
    }
  } else if (!strcmp(topic, "aqua/cmd/aquasense/rescan")) {
    if (!strncmp((char *)payload, "Lc9Jd65y6u74lNocw", 17)) {
      doScan = true;
    }
  }
}

void setupOTA() {
  // Port defaults to 8266
  // ArduinoOTA.setPort(8266);
  
  // Hostname defaults to esp8266-[ChipID]
  ArduinoOTA.setHostname(otaHost);
  
  // No authentication by default
  ArduinoOTA.setPassword(otaPassword);
  
  ArduinoOTA.onStart([]() {
    inOTA = true;
    Serial.print(F("\r\nOTA update starting...\r\n"));
  });
  
  ArduinoOTA.onEnd([]() {
    Serial.print(F("\r\nOTA update complete. Rebooting...\r\n"));
  });
  
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA update in progress: %u%%\r", (progress / (total / 100)));
  });
  
  ArduinoOTA.onError([](ota_error_t error) {
    inOTA = false;
    Serial.printf("\r\nOTA Error[%u]: ", error);
    switch(error) {
      case OTA_AUTH_ERROR:
        Serial.print(F("Auth Failed\r\n")); break;
      case OTA_BEGIN_ERROR:
        Serial.print(F("Begin Failed\r\n")); break;
      case OTA_CONNECT_ERROR:
        Serial.print(F("Connect Failed\r\n")); break;
      case OTA_RECEIVE_ERROR:
        Serial.print(F("Receive Failed\r\n")); break;
      case OTA_END_ERROR:
        Serial.print(F("End Failed\r\n")); break;
    }
  });
  
  ArduinoOTA.begin();
  Serial.print(F("OTA ready\r\n"));
}

// scan 1-wire bus for temperature sensors
// fills dsInfos[] struct with at most dsMax addresses
// returns the number of registered addresses
// TODO: requires global OneWire instance "ds"
byte scan1Wire(struct dsInfo dsInfos[], const byte dsMax) {
  byte addr[8];
  byte dsIdx = 0;
  String dsID;

  Serial.print(F("Searching 1-wire...\r\n"));

  ds.reset_search();

  while (dsIdx < dsMax && ds.search(addr)) {
    Serial.print(F("Detected device: "));

    dsID = "";
    for (size_t i = 0; i < sizeof(addr); i++) {
      if (addr[i] < 0x10) {
        dsID += String('0');
      }

      dsID += String(addr[i], HEX);
    }

    Serial.print(dsID);
    Serial.print(F(" - "));

    if (OneWire::crc8(addr, 7) != addr[7]) {
      Serial.print(F("invalid CRC!\r\n"));
      continue;
    }

    if (addr[0] == 0x28) {
      memcpy(&dsInfos[dsIdx].addr, &addr, sizeof(dsInfos[dsIdx].addr));
      memcpy(&dsInfos[dsIdx].id, dsID.c_str(), sizeof(dsInfos[dsIdx].id));
      dsInfos[dsIdx].id[sizeof(dsInfos[dsIdx].id)-1] = '\0';
      dsInfos[dsIdx].lastResult = ESENSOR;
      dsInfos[dsIdx].mean = NAN;
      if (dsInfos[dsIdx].filter) {  // rely on zero-initialized memory
        delete dsInfos[dsIdx].filter;
      }
      dsInfos[dsIdx].filter = NULL;
mqttPublish("aqua/tmp/test", dsInfos[dsIdx].id, false);

      dsIdx++;
      Serial.print(F("DS18B20 registered\r\n"));
    } else {
      Serial.print(F("unknown device ignored\r\n"));
    }
  }

  return dsIdx;
}

signed int readSensor(const byte addr[8]) {
  union {
    uint8_t scratchpad[9];
    struct {
      int16_t temperature;
      union {
        uint16_t userdata;
        struct {
          int8_t th;
          int8_t tl;
        };
      };
      union {
        uint8_t config;
        struct {
          uint8_t :5;
          uint8_t resolution :2;
          uint8_t :1;
        };
      };
      uint8_t reserved0, reserved1, reserved2;
      uint8_t crc;
    };
  } sensorData;

  // read temperature
  ds.reset();
  ds.select(addr);
  ds.write(0xBE);

  for (size_t i = 0; i < sizeof(sensorData.scratchpad); i++) {
    sensorData.scratchpad[i] = ds.read();
  }

  if (OneWire::crc8(sensorData.scratchpad, 8) == sensorData.crc) {
    return sensorData.temperature;
  } else {
    return ESENSOR;
  }
}

void readAllSensors() {
  for (byte i = 0; i < dsCount; i++) {
    String topic = tempTopic + String(dsInfos[i].id);
    String mtopic = topic + String("/mean");

    signed int result = readSensor(dsInfos[i].addr);

    if (result == ESENSOR) {
      // reset filter on error
      if (dsInfos[i].lastResult != ESENSOR) {
          dsInfos[i].lastResult = ESENSOR;
          dsInfos[i].mean = NAN;
          if (dsInfos[i].filter) {
            // release memory
            delete dsInfos[i].filter;
            dsInfos[i].filter = NULL;
          }
          Serial.print(dsInfos[i].id);
          Serial.print(F(": invalid CRC!\r\n"));
          mqttPublish(topic, "null", false);
          mqttPublish(mtopic, "null", false);
      }
    } else {
      if (!dsInfos[i].filter) {
        dsInfos[i].filter = new GaussianAverage(sensorSamples);
      }

//mqttPublish("aqua/tmp/test", "val: " + String(result), false);

      *(dsInfos[i].filter) += result;
      dsInfos[i].filter->process();
      double mean = dsInfos[i].filter->mean;
      double variance = dsInfos[i].filter->variance;

      if (isnan(dsInfos[i].mean) || abs(mean - dsInfos[i].mean) >= (0.01/0.0625)) {
        dsInfos[i].mean = mean;
        String fcelsius = String(mean * 0.0625, 4);
        mqttPublish(mtopic, fcelsius, false);
      }

      if (abs(result - dsInfos[i].lastResult) > 0) {
        dsInfos[i].lastResult = result;
        String celsius = String((double)result * 0.0625, 4);
        mqttPublish(topic, celsius, false);
      }
    }
  }
}

unsigned long diffMillis(const unsigned long last, const unsigned long now) {
  if (now < last) {
    return (~0UL - last) + now;
  } else {
    return now - last;
  }
}
