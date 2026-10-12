#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_ESP32C3_DEV)
// ESP32-C3 Feather Silk-screen Pin Mapping:
// A5  (GPIO 4) -> CS / CSB
// SCK (GPIO 5) -> SCK
// MO  (GPIO 6) -> MOSI / SDI
// MI  (GPIO 3) -> MISO / SDO
#define MAX30001_CS_PIN    4
#define MAX30001_SCK_PIN   5
#define MAX30001_MOSI_PIN  6
#define MAX30001_MISO_PIN  3
#else
// Standard ESP32 Feather Pin Mapping
#define MAX30001_CS_PIN    4
#define MAX30001_SCK_PIN   5
#define MAX30001_MOSI_PIN  18
#define MAX30001_MISO_PIN  19
#endif

// Optional Interrupt Pin (set to -1 if not wired)
#define MAX30001_INT1_PIN  -1

// ==========================================
// Wireless & Network Configuration
// ==========================================
#define WIFI_AP_SSID       "ESP32-MAX30001-ECG"
#define WIFI_AP_PASS       "12345678"
#define WEBSOCKET_PORT     81
#define HTTP_SERVER_PORT   80

#define BLE_DEVICE_NAME    "ESP32-ECG-MAX30001"
#define BT_SPP_NAME        "ESP32-ECG-MAX30001-SPP"

// BLE Service & Characteristic UUIDs
#define HEART_RATE_SERVICE_UUID     "0000180d-0000-1000-8000-00805f9b34fb"
#define HEART_RATE_CHAR_UUID        "00002a37-0000-1000-8000-00805f9b34fb"
#define ECG_SERVICE_UUID            "19B10000-E8F2-537E-4F6C-D104768A1214"
#define ECG_DATA_CHAR_UUID          "19B10001-E8F2-537E-4F6C-D104768A1214"

#endif // CONFIG_H
