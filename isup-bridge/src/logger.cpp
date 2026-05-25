#include "logger.h"

Logger& Logger::instance() {
    static Logger inst;
    return inst;
}

void Logger::setLevel(LogLevel level) {
    std::lock_guard<std::mutex> lock(mutex_);
    minLevel_ = level;
}

void Logger::setDeviceContext(const std::string& deviceId) {
    std::lock_guard<std::mutex> lock(mutex_);
    deviceContext_ = deviceId;
}

void Logger::clearDeviceContext() {
    std::lock_guard<std::mutex> lock(mutex_);
    deviceContext_.clear();
}

void Logger::debug(const std::string& msg, const std::string& context) {
    log(LogLevel::DEBUG, msg, context);
}

void Logger::info(const std::string& msg, const std::string& context) {
    log(LogLevel::INFO, msg, context);
}

void Logger::warn(const std::string& msg, const std::string& context) {
    log(LogLevel::WARN, msg, context);
}

void Logger::error(const std::string& msg, const std::string& context) {
    log(LogLevel::ERR, msg, context);
}

void Logger::log(LogLevel level, const std::string& msg, const std::string& context) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (level < minLevel_) return;

    std::string ctx = context.empty() ? deviceContext_ : context;

    std::cout << "{"
              << "\"timestamp\":\"" << currentTimestamp() << "\","
              << "\"level\":\"" << levelToString(level) << "\","
              << "\"message\":\"" << escapeJson(msg) << "\"";

    if (!ctx.empty()) {
        std::cout << ",\"device\":\"" << escapeJson(ctx) << "\"";
    }

    std::cout << "}" << std::endl;
}

std::string Logger::levelToString(LogLevel level) {
    switch (level) {
        case LogLevel::DEBUG: return "DEBUG";
        case LogLevel::INFO:  return "INFO";
        case LogLevel::WARN:  return "WARN";
        case LogLevel::ERR:   return "ERROR";
        default:              return "UNKNOWN";
    }
}

std::string Logger::currentTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);
    auto ms  = std::chrono::duration_cast<std::chrono::milliseconds>(
                   now.time_since_epoch()) % 1000;

    std::ostringstream oss;
    oss << std::put_time(std::gmtime(&t), "%Y-%m-%dT%H:%M:%S")
        << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return oss.str();
}

std::string Logger::escapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}
