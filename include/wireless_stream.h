#ifndef WIRELESS_STREAM_H
#define WIRELESS_STREAM_H

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#if !defined(CONFIG_IDF_TARGET_ESP32C3)
#include <BluetoothSerial.h>
#endif
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "config.h"
#include "max30001_handler.h"

// Nordic UART Service (NUS) UUIDs for Universal BLE Serial
#define NUS_SERVICE_UUID           "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_CHAR_UUID           "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

class WirelessStreamManager {
public:
    WirelessStreamManager();
    void begin();
    void update();
    void broadcastData(const MAX30001_Data &data);

private:
    WebServer _webServer;
    WebSocketsServer _webSocket;
#if !defined(CONFIG_IDF_TARGET_ESP32C3)
    BluetoothSerial _serialBT;
#endif

    BLEServer *_pBLEServer;
    BLECharacteristic *_pHeartRateChar;
    BLECharacteristic *_pECGDataChar;
    BLECharacteristic *_pNUSTXChar;
    bool _bleClientConnected;

    void setupWiFi();
    void setupWebServer();
    void setupBluetooth();
    void setupBLE();

    static const char INDEX_HTML[] PROGMEM;
};

#endif // WIRELESS_STREAM_H
