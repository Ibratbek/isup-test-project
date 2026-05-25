#pragma once

#include "redis_client.h"
#include <string>
#include <functional>
#include <unordered_map>

struct CommandResult {
    bool        success;
    std::string message;
    std::string data;   // optional JSON payload
};

// Callback type: (deviceId, params_json) -> CommandResult
using CommandFn = std::function<CommandResult(const std::string&, const std::string&)>;

class CommandHandler {
public:
    CommandHandler(RedisClient& redis);

    // Register SDK command implementations (called from ISUPServer)
    void registerCommand(const std::string& name, CommandFn fn);

    // Start listening on hikvision:commands
    void start();
    void stop();

    static constexpr const char* kCommandsChannel  = "hikvision:commands";
    static constexpr const char* kResponsesPrefix  = "hikvision:responses:";

private:
    void onMessage(const std::string& channel, const std::string& payload);
    void sendResponse(const std::string& commandId, const CommandResult& result);

    RedisClient& redis_;
    std::unordered_map<std::string, CommandFn> commands_;
};
