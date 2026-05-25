#pragma once

#include "event_handler.h"
#include "command_handler.h"
#include "redis_client.h"

#include <string>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <cstdint>

struct DeviceSession {
    std::string deviceId;
    std::string ip;
    uint32_t    loginHandle = 0;
    bool        online      = false;
};

struct ISUPConfig {
    std::string listenIp   = "0.0.0.0";
    uint16_t    listenPort = 7660;
    int         maxDevices = 100;
    std::string sdkLogPath = "/var/log/hikvision-isup/";
    int         sdkLogLevel = 3;
};

class ISUPServer {
public:
    ISUPServer(const ISUPConfig& config, RedisClient& redis);
    ~ISUPServer();

    bool init();
    bool start();
    void stop();

    // SDK global callback — must be static (C linkage compatible)
    static void CALLBACK alarmCallback(LONG lCommand,
                                       NET_DVR_ALARMER* pAlarmer,
                                       char* pAlarmInfo,
                                       DWORD dwBufLen,
                                       void* pUser);

    static void CALLBACK exceptionCallback(DWORD dwType,
                                           LONG lUserID,
                                           LONG lHandle,
                                           void* pUser);

private:
    // SDK command implementations registered in CommandHandler
    CommandResult cmdAddUser(const std::string& deviceId, const std::string& params);
    CommandResult cmdDeleteUser(const std::string& deviceId, const std::string& params);
    CommandResult cmdUpdateUser(const std::string& deviceId, const std::string& params);
    CommandResult cmdUploadFace(const std::string& deviceId, const std::string& params);
    CommandResult cmdOpenDoor(const std::string& deviceId, const std::string& params);
    CommandResult cmdRebootDevice(const std::string& deviceId, const std::string& params);
    CommandResult cmdSyncTime(const std::string& deviceId, const std::string& params);
    CommandResult cmdGetDeviceInfo(const std::string& deviceId, const std::string& params);

    // Device session management
    DeviceSession* findSession(const std::string& deviceId);
    LONG getLoginHandle(const std::string& deviceId);

    void registerCommands();
    std::string getLastSdkError();

    ISUPConfig     config_;
    RedisClient&   redis_;
    EventHandler   eventHandler_;
    CommandHandler commandHandler_;

    std::unordered_map<std::string, DeviceSession> sessions_;
    std::mutex sessionsMutex_;

    std::atomic<bool> running_{false};

    // Singleton pointer for static callback
    static ISUPServer* instance_;
};
