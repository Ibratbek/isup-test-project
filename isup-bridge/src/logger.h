#pragma once

#include <string>
#include <mutex>
#include <chrono>
#include <iomanip>
#include <sstream>
#include <iostream>

enum class LogLevel {
    DEBUG = 0,
    INFO  = 1,
    WARN  = 2,
    ERR   = 3
};

class Logger {
public:
    static Logger& instance();

    void setLevel(LogLevel level);
    void setDeviceContext(const std::string& deviceId);
    void clearDeviceContext();

    void debug(const std::string& msg, const std::string& context = "");
    void info(const std::string& msg, const std::string& context = "");
    void warn(const std::string& msg, const std::string& context = "");
    void error(const std::string& msg, const std::string& context = "");

private:
    Logger() = default;
    Logger(const Logger&) = delete;
    Logger& operator=(const Logger&) = delete;

    void log(LogLevel level, const std::string& msg, const std::string& context);
    std::string levelToString(LogLevel level);
    std::string currentTimestamp();
    std::string escapeJson(const std::string& s);

    LogLevel minLevel_ = LogLevel::INFO;
    std::string deviceContext_;
    std::mutex mutex_;
};

// Convenience macros
#define LOG_DEBUG(msg) Logger::instance().debug(msg)
#define LOG_INFO(msg)  Logger::instance().info(msg)
#define LOG_WARN(msg)  Logger::instance().warn(msg)
#define LOG_ERROR(msg) Logger::instance().error(msg)

#define LOG_DEBUG_CTX(msg, ctx) Logger::instance().debug(msg, ctx)
#define LOG_INFO_CTX(msg, ctx)  Logger::instance().info(msg, ctx)
#define LOG_WARN_CTX(msg, ctx)  Logger::instance().warn(msg, ctx)
#define LOG_ERROR_CTX(msg, ctx) Logger::instance().error(msg, ctx)
