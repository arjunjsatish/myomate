#include "max30001_handler.h"
#include <math.h>

// DSP Filter State Variables (512 SPS)
static float dcBaseline     = 0.0f;
static float currentECGuV   = 0.0f;

// 60 Hz IIR Notch Filter (fs = 512 Hz, f0 = 60 Hz, Q = 8, r = 0.9632)
// H(z) = (1 - 2*cos(w0)*z^-1 + z^-2) / (1 - 2*r*cos(w0)*z^-1 + r^2*z^-2)
// w0 = 2 * pi * 60 / 512 = 0.736310775 rad
// cos(w0) = 0.740951125
// b0 = 1.0, b1 = -1.48190225, b2 = 1.0
// a1 = -1.42736825, a2 = 0.92775424 (normalized with gain compensation)
static float notch_x1 = 0.0f, notch_x2 = 0.0f;
static float notch_y1 = 0.0f, notch_y2 = 0.0f;

// 40 Hz 2nd-order Butterworth Low-Pass Filter (fs = 512 Hz, fc = 40 Hz)
// Cutoff at 40 Hz preserves sharp clinical QRS complexes while cutting high-frequency EMG muscle tremor
static float lp_x1 = 0.0f, lp_x2 = 0.0f;
static float lp_y1 = 0.0f, lp_y2 = 0.0f;

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
    uint8_t etag = (fifoWord >> 3) & 0x07;

    // ETAG 0, 1, 2 are valid FIFO samples (000, 001, 010)
    // ETAG 3, 7 = Overflow (trigger FIFO reset)
    // ETAG 6 = FIFO Empty (skip read)
    if (etag == 3 || etag == 7) {
        writeReg(FIFO_RST, 0x000000);
        return false;
    } else if (etag <= 2) {
        uint32_t raw18 = (fifoWord >> 6) & 0x3FFFF;
        int32_t signed18 = (raw18 & 0x20000) ? (int32_t)(raw18 | 0xFFFC0000) : (int32_t)raw18;
        float raw_uV = (float)signed18 * 0.078125f;

        // 1. High-pass DC offset baseline cancellation (0.5 Hz Cutoff)
        dcBaseline = (0.003f * raw_uV) + (0.997f * dcBaseline);
        float ac_uV = raw_uV - dcBaseline;

        // 2. 60 Hz Notch Filter (fs = 512 Hz, f0 = 60 Hz)
        // y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
        float notch_in = ac_uV;
        float notch_out = (0.96387f * notch_in)
                        - (1.42841f * notch_x1)
                        + (0.96387f * notch_x2)
                        + (1.42841f * notch_y1)
                        - (0.92775f * notch_y2);
        notch_x2 = notch_x1;
        notch_x1 = notch_in;
        notch_y2 = notch_y1;
        notch_y1 = notch_out;

        // 3. 40 Hz 2nd-Order Low-Pass Filter (fs = 512 Hz, fc = 40 Hz)
        // Eliminates EMG muscle tremor and high-frequency noise
        float lp_in = notch_out;
        float lp_out = (0.04613f * lp_in)
                     + (0.09226f * lp_x1)
                     + (0.04613f * lp_x2)
                     + (1.30728f * lp_y1)
                     - (0.49181f * lp_y2);
        lp_x2 = lp_x1;
        lp_x1 = lp_in;
        lp_y2 = lp_y1;
        lp_y1 = lp_out;

        if (isnan(lp_out) || isinf(lp_out)) {
            lp_out = 0.0f;
            dcBaseline = 0.0f;
            notch_x1 = notch_x2 = notch_y1 = notch_y2 = 0.0f;
            lp_x1 = lp_x2 = lp_y1 = lp_y2 = 0.0f;
        }

        currentECGuV = lp_out;
        data.new_ecg = true;
    } else {
        // FIFO Empty (ETAG 6) or unhandled
        return false;
    }

    // 2. Read R-R Interval & Heart Rate from MAX30001 RTOR Engine (throttled to every 100ms)
    static unsigned long lastRtorCheckMs = 0;
    if (millis() - lastRtorCheckMs >= 100) {
        lastRtorCheckMs = millis();
        max30001_rtor_data_t rtorData;
        max30001_error_t err = _sensor.getRtoRData(&rtorData);
        if (err == MAX30001_SUCCESS && rtorData.rr_detected) {
            if (rtorData.heart_rate_bpm >= 30 && rtorData.heart_rate_bpm <= 220) {
                lastHeartRate = rtorData.heart_rate_bpm;
                lastRRms = rtorData.rr_interval_ms;
                data.new_rtor = true;
            }
        }
    }

    data.ecg_uV = currentECGuV;
    data.heart_rate_bpm = lastHeartRate;
    data.rtor_ms = lastRRms;
    data.lead_off = false;

    return data.new_ecg;
}
