#include "command_handler.h"
#include "logger.h"

#include <nlohmann/json.hpp>
using json = nlohmann::json;

CommandHandler::CommandHandler(RedisClient& redis) : redis_(redis) {}

void CommandHandler::registerCommand(const std::string& name, CommandFn fn) {
    commands_[name] = std::move(fn);
    LOG_INFO("Registered command: " + name);
}

void CommandHandler::start() {
    redis_.subscribe(kCommandsChannel,
        [this](const std::string& ch, const std::string& msg) {
            onMessage(ch, msg);
        });
    LOG_INFO("CommandHandler listening on " + std::string(kCommandsChannel));
}

void CommandHandler::stop() {
    redis_.unsubscribe(kCommandsChannel);
}

void CommandHandler::onMessage(const std::string& /*channel*/, const std::string& payload) {
    std::string commandId;
    try {
        auto j = json::parse(payload);

        commandId       = j.value("commandId", "");
        std::string cmd = j.value("command", "");
        std::string dev = j.value("deviceId", "");
        std::string par = j.contains("params") ? j["params"].dump() : "{}";

        LOG_INFO("Command received: " + cmd + " device=" + dev + " id=" + commandId);

        auto it = commands_.find(cmd);
        if (it == commands_.end()) {
            sendResponse(commandId, {false, "Unknown command: " + cmd, ""});
            return;
        }

        CommandResult result = it->second(dev, par);
        sendResponse(commandId, result);

    } catch (const std::exception& e) {
        LOG_ERROR("Command parse error: " + std::string(e.what()));
        if (!commandId.empty()) {
            sendResponse(commandId, {false, "Parse error: " + std::string(e.what()), ""});
        }
    }
}

void CommandHandler::sendResponse(const std::string& commandId, const CommandResult& result) {
    if (commandId.empty()) return;

    json resp;
    resp["commandId"] = commandId;
    resp["success"]   = result.success;
    resp["message"]   = result.message;
    if (!result.data.empty()) {
        try {
            resp["data"] = json::parse(result.data);
        } catch (...) {
            resp["data"] = result.data;
        }
    }

    std::string channel = std::string(kResponsesPrefix) + commandId;
    redis_.publish(channel, resp.dump());
}
