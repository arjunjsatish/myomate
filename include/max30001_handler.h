#ifndef MAX30001_HANDLER_H
#define MAX30001_HANDLER_H

#include <Arduino.h>
#include <SPI.h>
#include "protocentral_max30001.h"
#include "config.h"

struct MAX30001_Data {
    int32_t  raw_ecg;        // Raw 18-bit sample
    float    ecg_uV;         // Voltage in microvolts
    int32_t  raw_bioz;       // BioZ raw sample
    float    bioz_ohms;      // BioZ resistance in ohms
    uint16_t heart_rate_bpm; // Heart Rate in BPM
    uint16_t rtor_ms;        // R-to-R interval in ms
    bool     lead_off;       // Lead off status
    bool     new_ecg;        // New ECG sample flag
    bool     new_rtor;       // New RTOR flag
};

class MAX30001Handler {
public:
    MAX30001Handler(uint8_t csPin = MAX30001_CS_PIN,
                    uint8_t sckPin = MAX30001_SCK_PIN,
                    uint8_t mosiPin = MAX30001_MOSI_PIN,
                    uint8_t misoPin = MAX30001_MISO_PIN);

    bool begin();
    bool readSensorData(MAX30001_Data &data);
    bool isConnected();

    void writeReg(uint8_t regAddr, uint32_t data);
    uint32_t readReg(uint8_t regAddr);

private:
    uint8_t   _csPin;
    uint8_t   _sckPin;
    uint8_t   _mosiPin;
    uint8_t   _misoPin;
    bool      _initialized;
    MAX30001  _sensor;
};

#endif // MAX30001_HANDLER_H
