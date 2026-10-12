#include "max30001_handler.h"
#include <math.h>

// DSP Filter State Variables (128 SPS)
static float dcBaseline     = 0.0f;
static float filteredECGuV  = 0.0f;
static float currentECGuV   = 0.0f;

// 5-Point FIR Moving Window Filter (cancels 60Hz AC hum & baseline ripple)
static float firBuffer[5]   = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
static uint8_t firIndex     = 0;

// Duplicate suppression — track last raw FIFO word
static uint32_t lastFifoWord = 0xFFFFFFFF;

static uint16_t lastHeartRate = 65;
static uint16_t lastRRms      = 921;

MAX30001Handler::MAX30001Handler(uint8_t csPin, uint8_t sckPin, uint8_t mosiPin, uint8_t misoPin)
    : _csPin(csPin), _sckPin(sckPin), _mosiPin(mosiPin), _misoPin(misoPin),
      _initialized(false), _sensor(csPin, &SPI) {
}

bool MAX30001Handler::begin() {
    pinMode(_csPin, OUTPUT);
    digitalWrite(_csPin, HIGH);

    SPI.begin(_sckPin, _misoPin, _mosiPin, _csPin);
    delay(100);

    // Initialize ProtoCentral MAX30001 underlying library object
    _sensor.begin();
    delay(50);

    // Test Software Reset
    writeReg(SW_RST, 0x000000);
    delay(100);

    // Test reading INFO (0x0F) under MODE0
    uint32_t info0 = readReg(INFO);
    Serial.printf("[MAX30001 DIAG] MODE0 CS=%d SCK=%d MOSI=%d MISO=%d | INFO (0x0F): 0x%06X\n",
                  _csPin, _sckPin, _mosiPin, _misoPin, info0);

    // Test reading INFO (0x0F) under MODE3
    SPI.beginTransaction(SPISettings(MAX30001_SPI_SPEED, MSBFIRST, SPI_MODE3));
    digitalWrite(_csPin, LOW);
    delayMicroseconds(10);
    SPI.transfer((INFO << 1) | RREG);
    uint8_t b1 = SPI.transfer(0xFF);
    uint8_t b2 = SPI.transfer(0xFF);
    uint8_t b3 = SPI.transfer(0xFF);
    digitalWrite(_csPin, HIGH);
    SPI.endTransaction();
    uint32_t info3 = ((uint32_t)b1 << 16) | ((uint32_t)b2 << 8) | b3;
    Serial.printf("[MAX30001 DIAG] MODE3 | INFO (0x0F): 0x%06X\n", info3);

    // CNFG_GEN (0x10): Enable ECG, internal FMSTR clock, bias generator
    writeReg(CNFG_GEN, 0x081007);
    delay(50);

    // CNFG_CAL (0x12): Calibration settings
    writeReg(CNFG_CAL, 0x720000);
    delay(50);

    // CNFG_EMUX (0x14): Connect ECGP to AINP and ECGN to AINN (Active input channel multiplexer)
    writeReg(CNFG_EMUX, 0x0B0000);
    delay(50);

    // CNFG_ECG (0x15): Rate 512 SPS (0b00), ECG Gain 160 V/V (0b11), DHPF 0.5Hz, DLPF 40Hz -> 0x035000
    writeReg(CNFG_ECG, 0x035000);
    delay(50);

    // R-to-R Peak Detection Engine Registers
    writeReg(CNFG_RTOR1, 0x3FC600);
    writeReg(CNFG_RTOR2, 0x202400);
    delay(50);

    // Synchronize and reset FIFO
    writeReg(SYNCH, 0x000000);
    writeReg(FIFO_RST, 0x000000);
    delay(50);

    _initialized = true;
    Serial.println("[MAX30001] Hardware Register Init Complete: 512 SPS ECG Active!");
    return true;
}

void MAX30001Handler::writeReg(uint8_t regAddr, uint32_t data) {
    SPI.beginTransaction(SPISettings(MAX30001_SPI_SPEED, MSBFIRST, SPI_MODE0));
    digitalWrite(_csPin, LOW);

    uint8_t cmd = (regAddr << 1) | WREG;
    SPI.transfer(cmd);
    SPI.transfer((data >> 16) & 0xFF);
    SPI.transfer((data >> 8) & 0xFF);
    SPI.transfer(data & 0xFF);

    digitalWrite(_csPin, HIGH);
    SPI.endTransaction();
}

uint32_t MAX30001Handler::readReg(uint8_t regAddr) {
    SPI.beginTransaction(SPISettings(MAX30001_SPI_SPEED, MSBFIRST, SPI_MODE0));
    digitalWrite(_csPin, LOW);

    uint8_t cmd = (regAddr << 1) | RREG;
    SPI.transfer(cmd);
    uint8_t b1 = SPI.transfer(0xFF);
    uint8_t b2 = SPI.transfer(0xFF);
    uint8_t b3 = SPI.transfer(0xFF);

    digitalWrite(_csPin, HIGH);
    SPI.endTransaction();

    return ((uint32_t)b1 << 16) | ((uint32_t)b2 << 8) | b3;
}

bool MAX30001Handler::isConnected() {
    return _sensor.isConnected();
}

bool MAX30001Handler::readSensorData(MAX30001_Data &data) {
    if (!_initialized) return false;

    data.new_ecg = false;
    data.new_rtor = false;

    // 1. Read ECG Sample directly from MAX30001 ECG_FIFO (0x21)
    uint32_t fifoWord = readReg(ECG_FIFO);
    uint8_t etag = (fifoWord >> 21) & 0x07;

    // ETAG 0, 1, 2 are valid FIFO samples (000, 001, 010)
    // ETAG 3, 7 = Overflow (trigger FIFO reset)
    // ETAG 6 = FIFO Empty (skip read)
    if (etag == 3 || etag == 7) {
        writeReg(FIFO_RST, 0x000000);
    } else if (etag < 3 && fifoWord != lastFifoWord) {
        lastFifoWord = fifoWord;

        uint32_t raw18 = (fifoWord >> 3) & 0x3FFFF;
        int32_t signed18 = (raw18 & 0x20000) ? (int32_t)(raw18 | 0xFFFC0000) : (int32_t)raw18;
        float raw_uV = (float)signed18 * 0.095367f;

        // High-pass DC offset cancellation (0.5 Hz Cutoff)
        dcBaseline = (0.015f * raw_uV) + (0.985f * dcBaseline);
        float ac_uV = raw_uV - dcBaseline;

        // 5-Point FIR Moving Average Filter (light smoothing only)
        firBuffer[firIndex] = ac_uV;
        firIndex = (firIndex + 1) % 5;
        float fir_uV = (firBuffer[0] + firBuffer[1] + firBuffer[2] + firBuffer[3] + firBuffer[4]) / 5.0f;

        // Light exponential smoothing (alpha=0.5) — at 512 SPS this gives ~55 Hz cutoff
        // preserving ECG dynamics while cutting high-freq jitter
        filteredECGuV = (0.5f * fir_uV) + (0.5f * filteredECGuV);

        if (isnan(filteredECGuV) || isinf(filteredECGuV)) {
            filteredECGuV = 0.0f;
            dcBaseline = 0.0f;
        }

        currentECGuV = filteredECGuV;
        data.new_ecg = true;
    }

    // 2. Read R-R Interval & Heart Rate from MAX30001 RTOR Engine
    max30001_rtor_data_t rtorData;
    max30001_error_t err = _sensor.getRtoRData(&rtorData);
    if (err == MAX30001_SUCCESS && rtorData.rr_detected) {
        if (rtorData.heart_rate_bpm >= 30 && rtorData.heart_rate_bpm <= 220) {
            lastHeartRate = rtorData.heart_rate_bpm;
            lastRRms = rtorData.rr_interval_ms;
            data.new_rtor = true;
        }
    }

    data.ecg_uV = currentECGuV;
    data.heart_rate_bpm = lastHeartRate;
    data.rtor_ms = lastRRms;
    data.lead_off = false;

    return data.new_ecg;
}
