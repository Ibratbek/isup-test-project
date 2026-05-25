#include "isup_server.h"
#include "redis_client.h"
#include "logger.h"

#include <nlohmann/json.hpp>

#include <csignal>
#include <fstream>
#include <stdexcept>
#include <atomic>
#include <condition_variable>
#include <mutex>

using json = nlohmann::json;

static std::atomic<bool> gShutdown{false};
static std::mutex gMutex;
static std::condition_variable gCv;

static void signalHandler(int sig) {
    LOG_WARN("Signal received: " + std::to_string(sig) + ", shutting down...");
    gShutdown = true;
    gCv.notify_all();
}

static json loadConfig(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open()) {
        throw std::runtime_error("Cannot open config: " + path);
    }
    return json::parse(f);
}

int main(int argc, char* argv[]) {
    std::string configPath = (argc > 1) ? argv[1] : "config.json";

    // Signals
    signal(SIGINT,  signalHandler);
    signal(SIGTERM, signalHandler);

    LOG_INFO("Hikvision ISUP Bridge starting...");

    // Load config
    json cfg;
    try {
        cfg = loadConfig(configPath);
    } catch (const std::exception& e) {
        LOG_ERROR("Config load error: " + std::string(e.what()));
        return 1;
    }

    // Set log level
    std::string logLevelStr = cfg.value("log_level", "info");
    if      (logLevelStr == "debug") Logger::instance().setLevel(LogLevel::DEBUG);
    else if (logLevelStr == "warn")  Logger::instance().setLevel(LogLevel::WARN);
    else if (logLevelStr == "error") Logger::instance().setLevel(LogLevel::ERR);
    else                             Logger::instance().setLevel(LogLevel::INFO);

    // Redis config
    std::string redisHost = cfg["redis"].value("host", "127.0.0.1");
    int         redisPort = cfg["redis"].value("port", 6379);

    RedisClient redis(redisHost, redisPort);

    LOG_INFO("Connecting to Redis " + redisHost + ":" + std::to_string(redisPort));
    if (!redis.connect()) {
        LOG_ERROR("Redis connection failed — cannot start without message bus");
        return 1;
    }

    redis.startSubscribeLoop();

    // ISUP config
    ISUPConfig isupCfg;
    isupCfg.listenIp    = cfg["isup"].value("listen_ip",   "0.0.0.0");
    isupCfg.listenPort  = cfg["isup"].value("listen_port", 7660);
    isupCfg.maxDevices  = cfg["isup"].value("max_devices", 100);
    isupCfg.sdkLogPath  = cfg["sdk"].value("log_path",     "/var/log/hikvision-isup/");
    isupCfg.sdkLogLevel = cfg["sdk"].value("log_level",    3);

    ISUPServer server(isupCfg, redis);

    if (!server.init()) {
        LOG_ERROR("SDK init failed");
        return 1;
    }

    if (!server.start()) {
        LOG_ERROR("ISUP server start failed");
        return 1;
    }

    LOG_INFO("Bridge is running. Press Ctrl+C to stop.");

    // Wait for shutdown signal
    std::unique_lock<std::mutex> lock(gMutex);
    gCv.wait(lock, [] { return gShutdown.load(); });

    LOG_INFO("Shutting down...");
    server.stop();
    redis.stopSubscribeLoop();
    redis.disconnect();

    LOG_INFO("Goodbye.");
    return 0;
}
