#pragma once

#include "redis_client.h"
#include <string>
#include <cstdint>

// Forward declare SDK types
struct NET_DVR_ALARMER;
struct NET_DVR_ALARM_ISAPI_INFO;

// Hikvision alarm type codes used in ISUP events
enum class AlarmType : uint32_t {
    FaceRecognition = 0x2C01,  // Yuz tanish hodisasi
    AccessControl   = 0x2C02,  // Kirish nazorati
    MotionDetection = 0x0001,  // Harakatni aniqlash
    DoorStatus      = 0x2C05,  // Eshik holati
    DeviceStatus    = 0xFFFF,  // Qurilma holati (ichki)
};

class EventHandler {
public:
    explicit EventHandler(RedisClient& redis);

    // Called from ISUP SDK callback (runs in SDK thread — must be fast & thread-safe)
    void onAlarm(const NET_DVR_ALARMER* alarmer,
                 uint32_t alarmType,
                 const char* alarmInfo,
                 uint32_t bufLen);

    // Device online/offline events
    void onDeviceOnline(const std::string& deviceId, const std::string& ip);
    void onDeviceOffline(const std::string& deviceId);

    static constexpr const char* kEventsChannel = "hikvision:events";

private:
    void publishFaceEvent(const std::string& deviceId, const char* xmlData, uint32_t len);
    void publishAccessEvent(const std::string& deviceId, const char* xmlData, uint32_t len);
    void publishAlarmEvent(const std::string& deviceId, uint32_t alarmType,
                           const char* xmlData, uint32_t len);

    std::string buildBaseEvent(const std::string& type, const std::string& deviceId);
    std::string currentTimestamp();
    std::string extractXmlField(const std::string& xml, const std::string& tag);
    std::string base64Encode(const unsigned char* data, size_t len);

    RedisClient& redis_;
};
