#include "event_handler.h"
#include "logger.h"

// Hikvision SDK headers — must be installed at /opt/hikvision-sdk/include/
#include "HCNetSDK.h"

#include <chrono>
#include <sstream>
#include <iomanip>
#include <regex>
#include <cstring>

EventHandler::EventHandler(RedisClient& redis) : redis_(redis) {}

void EventHandler::onAlarm(const NET_DVR_ALARMER* alarmer,
                            uint32_t alarmType,
                            const char* alarmInfo,
                            uint32_t bufLen) {
    if (!alarmer) return;

    std::string deviceId = alarmer->sDeviceID[0]
                         ? std::string(alarmer->sDeviceID)
                         : std::to_string(alarmer->dwAlarmHandle);

    LOG_INFO_CTX("Alarm received, type=0x" +
                 [&]{ std::ostringstream ss; ss << std::hex << alarmType; return ss.str(); }(),
                 deviceId);

    switch (static_cast<AlarmType>(alarmType)) {
        case AlarmType::FaceRecognition:
            publishFaceEvent(deviceId, alarmInfo, bufLen);
            break;

        case AlarmType::AccessControl:
            publishAccessEvent(deviceId, alarmInfo, bufLen);
            break;

        default:
            publishAlarmEvent(deviceId, alarmType, alarmInfo, bufLen);
            break;
    }
}

void EventHandler::onDeviceOnline(const std::string& deviceId, const std::string& ip) {
    std::string json = buildBaseEvent("device_online", deviceId);
    // Remove closing brace and append extra fields
    json.pop_back();
    json += ",\"ip\":\"" + ip + "\",\"status\":\"online\"}";

    redis_.publish(kEventsChannel, json);
    LOG_INFO_CTX("Device came online, ip=" + ip, deviceId);
}

void EventHandler::onDeviceOffline(const std::string& deviceId) {
    std::string json = buildBaseEvent("device_offline", deviceId);
    json.pop_back();
    json += ",\"status\":\"offline\"}";

    redis_.publish(kEventsChannel, json);
    LOG_WARN_CTX("Device went offline", deviceId);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

void EventHandler::publishFaceEvent(const std::string& deviceId,
                                    const char* xmlData, uint32_t len) {
    std::string xml(xmlData ? xmlData : "", len);

    std::string employeeId  = extractXmlField(xml, "employeeNoString");
    std::string similarity  = extractXmlField(xml, "similarity");
    std::string cardNo      = extractXmlField(xml, "cardNo");
    std::string doorId      = extractXmlField(xml, "doorNo");

    // TODO: SDK docs'dan tekshirish — face image pointer structure
    // NET_DVR_FACE_REC_ALARM ichida pictureData bo'lishi kerak

    std::string json = buildBaseEvent("face_recognition", deviceId);
    json.pop_back();
    json += ",\"employeeId\":\"" + employeeId + "\""
          + ",\"similarity\":" + (similarity.empty() ? "0" : similarity)
          + ",\"cardNo\":\"" + cardNo + "\""
          + ",\"doorId\":\"" + doorId + "\""
          + ",\"faceImage\":null"   // filled when image data available
          + "}";

    redis_.publish(kEventsChannel, json);
    LOG_INFO_CTX("Face event published, employee=" + employeeId, deviceId);
}

void EventHandler::publishAccessEvent(const std::string& deviceId,
                                      const char* xmlData, uint32_t len) {
    std::string xml(xmlData ? xmlData : "", len);

    std::string employeeId = extractXmlField(xml, "employeeNoString");
    std::string doorId     = extractXmlField(xml, "doorNo");
    std::string direction  = extractXmlField(xml, "direction");

    std::string json = buildBaseEvent("access_control", deviceId);
    json.pop_back();
    json += ",\"employeeId\":\"" + employeeId + "\""
          + ",\"doorId\":\"" + doorId + "\""
          + ",\"direction\":\"" + direction + "\""
          + "}";

    redis_.publish(kEventsChannel, json);
    LOG_INFO_CTX("Access event published, employee=" + employeeId + " door=" + doorId, deviceId);
}

void EventHandler::publishAlarmEvent(const std::string& deviceId,
                                     uint32_t alarmType,
                                     const char* xmlData, uint32_t /*len*/) {
    std::ostringstream typeHex;
    typeHex << "0x" << std::hex << std::uppercase << alarmType;

    std::string json = buildBaseEvent("alarm", deviceId);
    json.pop_back();
    json += ",\"alarmType\":\"" + typeHex.str() + "\""
          + "}";

    redis_.publish(kEventsChannel, json);
}

std::string EventHandler::buildBaseEvent(const std::string& type,
                                         const std::string& deviceId) {
    return "{\"type\":\"" + type + "\""
         + ",\"deviceId\":\"" + deviceId + "\""
         + ",\"timestamp\":\"" + currentTimestamp() + "\""
         + "}";
}

std::string EventHandler::currentTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);
    auto ms  = std::chrono::duration_cast<std::chrono::milliseconds>(
                   now.time_since_epoch()) % 1000;

    std::ostringstream oss;
    oss << std::put_time(std::gmtime(&t), "%Y-%m-%dT%H:%M:%S")
        << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return oss.str();
}

std::string EventHandler::extractXmlField(const std::string& xml, const std::string& tag) {
    // Simple tag extractor — no full XML parser dependency needed for single values
    std::string open  = "<" + tag + ">";
    std::string close = "</" + tag + ">";

    auto start = xml.find(open);
    if (start == std::string::npos) return "";
    start += open.size();

    auto end = xml.find(close, start);
    if (end == std::string::npos) return "";

    return xml.substr(start, end - start);
}

std::string EventHandler::base64Encode(const unsigned char* data, size_t len) {
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string out;
    out.reserve(((len + 2) / 3) * 4);

    for (size_t i = 0; i < len; i += 3) {
        uint32_t n  = (uint32_t)data[i] << 16;
        if (i + 1 < len) n |= (uint32_t)data[i + 1] << 8;
        if (i + 2 < len) n |= (uint32_t)data[i + 2];

        out += table[(n >> 18) & 0x3F];
        out += table[(n >> 12) & 0x3F];
        out += (i + 1 < len) ? table[(n >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? table[n & 0x3F]        : '=';
    }

    return out;
}
