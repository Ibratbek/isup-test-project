#include "isup_server.h"
#include "logger.h"

#include "HCNetSDK.h"

#include <nlohmann/json.hpp>
#include <cstring>
#include <sstream>
#include <chrono>
#include <ctime>
#include <vector>
#include <stdexcept>

using json = nlohmann::json;

ISUPServer* ISUPServer::instance_ = nullptr;

ISUPServer::ISUPServer(const ISUPConfig& config, RedisClient& redis)
    : config_(config)
    , redis_(redis)
    , eventHandler_(redis)
    , commandHandler_(redis) {

    if (instance_) {
        throw std::runtime_error("Only one ISUPServer instance allowed");
    }
    instance_ = this;
}

ISUPServer::~ISUPServer() {
    stop();
    instance_ = nullptr;
}

bool ISUPServer::init() {
    LOG_INFO("Initializing Hikvision SDK...");

    if (!NET_DVR_Init()) {
        LOG_ERROR("NET_DVR_Init failed: " + getLastSdkError());
        return false;
    }

    // SDK log
    NET_DVR_SetLogToFile(config_.sdkLogLevel,
                         const_cast<char*>(config_.sdkLogPath.c_str()),
                         TRUE);

    // Connection timeouts
    NET_DVR_SetConnectTime(5000, 3);
    NET_DVR_SetReconnect(10000, TRUE);

    // Register global alarm callback
    // TODO: SDK docs'dan tekshirish — NET_DVR_SetDVRMessageCallBack_V51 signature
    NET_DVR_SetDVRMessageCallBack_V51(0, alarmCallback, this);

    LOG_INFO("SDK initialized successfully");
    return true;
}

bool ISUPServer::start() {
    LOG_INFO("Starting ISUP listener on " +
             config_.listenIp + ":" + std::to_string(config_.listenPort));

    // NET_ECMS_StartListen starts the ISUP 5.0 server
    // TODO: SDK docs'dan tekshirish — exact parameter types
    LONG handle = NET_ECMS_StartListen(
        const_cast<char*>(config_.listenIp.c_str()),
        config_.listenPort,
        nullptr  // verify code (optional per SDK)
    );

    if (handle < 0) {
        LOG_ERROR("NET_ECMS_StartListen failed: " + getLastSdkError());
        return false;
    }

    running_ = true;
    registerCommands();
    commandHandler_.start();

    LOG_INFO("ISUP server started, handle=" + std::to_string(handle));
    return true;
}

void ISUPServer::stop() {
    if (!running_) return;
    running_ = false;

    commandHandler_.stop();

    // TODO: SDK docs'dan tekshirish — NET_ECMS_StopListen
    NET_ECMS_StopListen(config_.listenPort);

    NET_DVR_Cleanup();
    LOG_INFO("ISUP server stopped, SDK cleaned up");
}

// ---------------------------------------------------------------------------
// Static SDK callbacks
// ---------------------------------------------------------------------------

void CALLBACK ISUPServer::alarmCallback(LONG /*lCommand*/,
                                         NET_DVR_ALARMER* pAlarmer,
                                         char* pAlarmInfo,
                                         DWORD dwBufLen,
                                         void* pUser) {
    ISUPServer* self = static_cast<ISUPServer*>(pUser);
    if (!self || !pAlarmer) return;

    // TODO: SDK docs'dan tekshirish — correct alarm type field in NET_DVR_ALARMER
    self->eventHandler_.onAlarm(pAlarmer,
                                pAlarmer->dwAlarmType,
                                pAlarmInfo,
                                static_cast<uint32_t>(dwBufLen));
}

void CALLBACK ISUPServer::exceptionCallback(DWORD dwType,
                                             LONG lUserID,
                                             LONG /*lHandle*/,
                                             void* /*pUser*/) {
    switch (dwType) {
        case EXCEPTION_RECONNECT:
            LOG_WARN("Device reconnecting, userID=" + std::to_string(lUserID));
            break;
        default:
            LOG_WARN("SDK exception type=" + std::to_string(dwType) +
                     " userID=" + std::to_string(lUserID));
            break;
    }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

void ISUPServer::registerCommands() {
    using namespace std::placeholders;

    commandHandler_.registerCommand("add_user",
        [this](auto& d, auto& p){ return cmdAddUser(d, p); });
    commandHandler_.registerCommand("delete_user",
        [this](auto& d, auto& p){ return cmdDeleteUser(d, p); });
    commandHandler_.registerCommand("update_user",
        [this](auto& d, auto& p){ return cmdUpdateUser(d, p); });
    commandHandler_.registerCommand("upload_face",
        [this](auto& d, auto& p){ return cmdUploadFace(d, p); });
    commandHandler_.registerCommand("open_door",
        [this](auto& d, auto& p){ return cmdOpenDoor(d, p); });
    commandHandler_.registerCommand("reboot_device",
        [this](auto& d, auto& p){ return cmdRebootDevice(d, p); });
    commandHandler_.registerCommand("sync_time",
        [this](auto& d, auto& p){ return cmdSyncTime(d, p); });
    commandHandler_.registerCommand("get_device_info",
        [this](auto& d, auto& p){ return cmdGetDeviceInfo(d, p); });
}

CommandResult ISUPServer::cmdAddUser(const std::string& deviceId,
                                     const std::string& params) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    try {
        auto p = json::parse(params);
        std::string employeeId = p.value("employeeId", "");
        std::string name       = p.value("name", "");
        std::string cardNo     = p.value("cardNo", "");

        if (employeeId.empty()) return {false, "employeeId required", ""};

        NET_DVR_CARD_RECORD card{};
        card.dwSize = sizeof(NET_DVR_CARD_RECORD);
        strncpy(card.byCardNo, cardNo.c_str(), sizeof(card.byCardNo) - 1);
        strncpy(card.byName,   name.c_str(),   sizeof(card.byName) - 1);
        card.byCardType = 1;  // Normal card
        card.dwDoorRight = 0xFFFFFFFF; // All doors

        NET_DVR_CARD_COND cond{};
        cond.dwSize = sizeof(NET_DVR_CARD_COND);
        cond.dwCardNum = 1;

        LONG setHandle = NET_DVR_StartRemoteConfig(
            handle, NET_DVR_SET_CARD, &cond, sizeof(cond), nullptr, nullptr);

        if (setHandle < 0) {
            return {false, "NET_DVR_StartRemoteConfig failed: " + getLastSdkError(), ""};
        }

        DWORD ret = NET_DVR_SendWithRecvRemoteConfig(
            setHandle, &card, sizeof(card), nullptr, 0, nullptr);

        NET_DVR_StopRemoteConfig(setHandle);

        if (ret == NET_DVR_FAILED) {
            return {false, "Add user failed: " + getLastSdkError(), ""};
        }

        LOG_INFO_CTX("User added: " + employeeId, deviceId);
        return {true, "User added successfully", "{\"employeeId\":\"" + employeeId + "\"}"};

    } catch (const std::exception& e) {
        return {false, "Parameter error: " + std::string(e.what()), ""};
    }
}

CommandResult ISUPServer::cmdDeleteUser(const std::string& deviceId,
                                        const std::string& params) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    try {
        auto p = json::parse(params);
        std::string cardNo = p.value("cardNo", "");
        if (cardNo.empty()) return {false, "cardNo required", ""};

        NET_DVR_CARD_COND cond{};
        cond.dwSize    = sizeof(NET_DVR_CARD_COND);
        cond.dwCardNum = 1;

        NET_DVR_DELETE_CARD delCard{};
        delCard.dwSize = sizeof(NET_DVR_DELETE_CARD);
        strncpy(delCard.byCardNo, cardNo.c_str(), sizeof(delCard.byCardNo) - 1);

        LONG setHandle = NET_DVR_StartRemoteConfig(
            handle, NET_DVR_DEL_CARD, &cond, sizeof(cond), nullptr, nullptr);

        if (setHandle < 0) {
            return {false, "NET_DVR_StartRemoteConfig failed: " + getLastSdkError(), ""};
        }

        NET_DVR_SendWithRecvRemoteConfig(
            setHandle, &delCard, sizeof(delCard), nullptr, 0, nullptr);

        NET_DVR_StopRemoteConfig(setHandle);

        LOG_INFO_CTX("User deleted: cardNo=" + cardNo, deviceId);
        return {true, "User deleted", ""};

    } catch (const std::exception& e) {
        return {false, std::string(e.what()), ""};
    }
}

CommandResult ISUPServer::cmdUpdateUser(const std::string& deviceId,
                                        const std::string& params) {
    // Update = delete old + add new (SDK typically requires this approach)
    auto del = cmdDeleteUser(deviceId, params);
    if (!del.success) return del;
    return cmdAddUser(deviceId, params);
}

CommandResult ISUPServer::cmdUploadFace(const std::string& deviceId,
                                        const std::string& params) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    try {
        auto p = json::parse(params);
        std::string employeeId = p.value("employeeId", "");
        std::string cardNo     = p.value("cardNo", "");
        std::string base64Img  = p.value("faceImage", "");

        if (base64Img.empty()) return {false, "faceImage (base64) required", ""};

        // TODO: SDK docs'dan tekshirish — NET_DVR_FACE_PARAM_CTRL structure
        // and NET_DVR_SET_FACE for face template upload
        // Typical flow: NET_DVR_StartRemoteConfig(NET_DVR_SET_FACE_PARAM_CFG_V50)

        LOG_WARN_CTX("cmdUploadFace: TODO implement face upload via SDK", deviceId);
        return {true, "Face upload queued (TODO: SDK implementation)", ""};

    } catch (const std::exception& e) {
        return {false, std::string(e.what()), ""};
    }
}

CommandResult ISUPServer::cmdOpenDoor(const std::string& deviceId,
                                      const std::string& params) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    try {
        auto p = json::parse(params);
        int doorIndex = p.value("doorIndex", 1);

        NET_DVR_ACCESS_CONTROL_PARAM ctrl{};
        ctrl.dwSize       = sizeof(ctrl);
        ctrl.dwChannel    = static_cast<DWORD>(doorIndex);
        ctrl.byCtrlType   = 1; // Normally open

        DWORD ret = NET_DVR_RemoteControl(handle, NET_DVR_ACCESS_CONTROL_ALARM_W, &ctrl, sizeof(ctrl));
        if (!ret) {
            return {false, "Open door failed: " + getLastSdkError(), ""};
        }

        LOG_INFO_CTX("Door opened: door=" + std::to_string(doorIndex), deviceId);
        return {true, "Door opened", ""};

    } catch (const std::exception& e) {
        return {false, std::string(e.what()), ""};
    }
}

CommandResult ISUPServer::cmdRebootDevice(const std::string& deviceId,
                                          const std::string& /*params*/) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    if (!NET_DVR_RebootDVR(handle)) {
        return {false, "Reboot failed: " + getLastSdkError(), ""};
    }

    LOG_INFO_CTX("Device reboot command sent", deviceId);
    return {true, "Reboot command sent", ""};
}

CommandResult ISUPServer::cmdSyncTime(const std::string& deviceId,
                                      const std::string& /*params*/) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    time_t now = time(nullptr);
    tm* t = gmtime(&now);

    NET_DVR_TIME devTime{};
    devTime.dwYear   = t->tm_year + 1900;
    devTime.dwMonth  = t->tm_mon + 1;
    devTime.dwDay    = t->tm_mday;
    devTime.dwHour   = t->tm_hour;
    devTime.dwMinute = t->tm_min;
    devTime.dwSecond = t->tm_sec;

    DWORD ret = NET_DVR_SetDVRConfig(handle, NET_DVR_SET_TIMECFG, 0,
                                     &devTime, sizeof(devTime));
    if (!ret) {
        return {false, "SyncTime failed: " + getLastSdkError(), ""};
    }

    LOG_INFO_CTX("Time synchronized", deviceId);
    return {true, "Time synchronized", ""};
}

CommandResult ISUPServer::cmdGetDeviceInfo(const std::string& deviceId,
                                           const std::string& /*params*/) {
    LONG handle = getLoginHandle(deviceId);
    if (handle < 0) return {false, "Device not connected: " + deviceId, ""};

    NET_DVR_DEVICEINFO_V40 info{};
    DWORD ret = NET_DVR_GetDVRConfig(handle, NET_DVR_GET_DEVICEINFO_V40,
                                     0, &info, sizeof(info), nullptr);
    if (!ret) {
        return {false, "GetDeviceInfo failed: " + getLastSdkError(), ""};
    }

    json data;
    data["serialNumber"] = std::string(reinterpret_cast<char*>(info.struDeviceV30.sSerialNumber));
    data["model"]        = std::string(reinterpret_cast<char*>(info.struDeviceV30.byDVRType));
    data["firmwareVer"]  = std::to_string(info.struDeviceV30.byFirmwareVersion[0]) + "." +
                           std::to_string(info.struDeviceV30.byFirmwareVersion[1]);
    data["channels"]     = info.struDeviceV30.byChanNum;

    return {true, "OK", data.dump()};
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

DeviceSession* ISUPServer::findSession(const std::string& deviceId) {
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    auto it = sessions_.find(deviceId);
    return it != sessions_.end() ? &it->second : nullptr;
}

LONG ISUPServer::getLoginHandle(const std::string& deviceId) {
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    auto it = sessions_.find(deviceId);
    if (it == sessions_.end() || !it->second.online) return -1;
    return static_cast<LONG>(it->second.loginHandle);
}

std::string ISUPServer::getLastSdkError() {
    DWORD code = NET_DVR_GetLastError();
    return "code=" + std::to_string(code);
}
