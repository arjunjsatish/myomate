#include <Arduino.h>
#include "config.h"
#include "max30001_handler.h"
#include "wireless_stream.h"

MAX30001Handler max30001(MAX30001_CS_PIN, MAX30001_SCK_PIN, MAX30001_MOSI_PIN, MAX30001_MISO_PIN);
WirelessStreamManager wireless;

unsigned long lastSampleMicros = 0;

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n=======================================================");
    Serial.println("  Adafruit ESP32 Feather + ProtoCentral MAX30001 Board ");
    Serial.println("  ECG & Bio-Impedance Wireless Streaming Firmware     ");
    Serial.println("=======================================================");
    Serial.printf("Pin Map: CS=A5(GPIO %d), SCK=GPIO %d, MOSI=GPIO %d, MISO=GPIO %d\n",
                  MAX30001_CS_PIN, MAX30001_SCK_PIN, MAX30001_MOSI_PIN, MAX30001_MISO_PIN);

    // Initialize MAX30001 Hardware SPI Driver
    if (!max30001.begin()) {
        Serial.println("[WARNING] Sensor initialization fallback active.");
    } else {
        Serial.println("[SUCCESS] MAX30001 SPI Interface online.");
    }

    // Initialize Wireless Engines (Wi-Fi AP, WebSockets, Bluetooth SPP, BLE)
    wireless.begin();
    Serial.println("[SYSTEM] All services started. Ready for streaming!\n");
}

void loop() {
    // 1. Maintain Wi-Fi & WebSockets state
    wireless.update();

    // 2. Poll MAX30001 at precise 512 Hz (1953 microseconds per conversion)
    if (micros() - lastSampleMicros >= 1953) {
        lastSampleMicros = micros();

        MAX30001_Data sensorData;
        if (max30001.readSensorData(sensorData)) {
            // Stream packet over WebSockets, BLE, and Bluetooth SPP
            wireless.broadcastData(sensorData);

            // Stream debug log & telemetry data over USB Serial
            Serial.printf("ECG:%.2f|HR:%u|RR:%u|Lead:%s\n",
                          sensorData.ecg_uV,
                          sensorData.heart_rate_bpm,
                          sensorData.rtor_ms,
                          sensorData.lead_off ? "DISCONNECTED" : "CONNECTED");
        }
    }
}
