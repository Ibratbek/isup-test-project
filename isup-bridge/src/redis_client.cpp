#include "redis_client.h"
#include "logger.h"

#include <hiredis/hiredis.h>
#include <chrono>
#include <stdexcept>

RedisClient::RedisClient(const std::string& host, int port)
    : host_(host), port_(port) {}

RedisClient::~RedisClient() {
    stopSubscribeLoop();
    disconnect();
}

bool RedisClient::connect() {
    struct timeval timeout = {2, 0}; // 2 seconds

    pubCtx_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
    if (!pubCtx_ || pubCtx_->err) {
        std::string err = pubCtx_ ? pubCtx_->errstr : "allocation failed";
        LOG_ERROR("Redis pub connect failed: " + err);
        if (pubCtx_) { redisFree(pubCtx_); pubCtx_ = nullptr; }
        return false;
    }

    subCtx_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
    if (!subCtx_ || subCtx_->err) {
        std::string err = subCtx_ ? subCtx_->errstr : "allocation failed";
        LOG_ERROR("Redis sub connect failed: " + err);
        if (subCtx_) { redisFree(subCtx_); subCtx_ = nullptr; }
        redisFree(pubCtx_); pubCtx_ = nullptr;
        return false;
    }

    connected_ = true;
    LOG_INFO("Redis connected to " + host_ + ":" + std::to_string(port_));
    return true;
}

void RedisClient::disconnect() {
    connected_ = false;

    if (pubCtx_) { redisFree(pubCtx_); pubCtx_ = nullptr; }
    if (subCtx_) { redisFree(subCtx_); subCtx_ = nullptr; }

    LOG_INFO("Redis disconnected");
}

bool RedisClient::isConnected() const {
    return connected_.load();
}

bool RedisClient::publish(const std::string& channel, const std::string& message) {
    std::lock_guard<std::mutex> lock(pubMutex_);

    if (!pubCtx_ || !connected_) {
        LOG_WARN("Redis publish: not connected, channel=" + channel);
        return false;
    }

    redisReply* reply = (redisReply*)redisCommand(
        pubCtx_, "PUBLISH %s %s", channel.c_str(), message.c_str());

    if (!reply) {
        LOG_ERROR("Redis PUBLISH failed (null reply), channel=" + channel);
        connected_ = false;
        return false;
    }

    bool ok = (reply->type != REDIS_REPLY_ERROR);
    if (!ok) {
        LOG_ERROR("Redis PUBLISH error: " + std::string(reply->str ? reply->str : "?"));
    }

    freeReplyObject(reply);
    return ok;
}

bool RedisClient::subscribe(const std::string& channel, MessageCallback callback) {
    {
        std::lock_guard<std::mutex> lock(callbackMutex_);
        callbacks_[channel] = std::move(callback);
    }

    if (!subCtx_ || !connected_) {
        LOG_WARN("Redis subscribe: not connected yet, will subscribe on reconnect");
        return false;
    }

    redisReply* reply = (redisReply*)redisCommand(
        subCtx_, "SUBSCRIBE %s", channel.c_str());

    if (!reply) {
        LOG_ERROR("Redis SUBSCRIBE failed, channel=" + channel);
        return false;
    }

    freeReplyObject(reply);
    LOG_INFO("Subscribed to Redis channel: " + channel);
    return true;
}

void RedisClient::unsubscribe(const std::string& channel) {
    std::lock_guard<std::mutex> lock(callbackMutex_);
    callbacks_.erase(channel);

    if (subCtx_ && connected_) {
        redisReply* reply = (redisReply*)redisCommand(
            subCtx_, "UNSUBSCRIBE %s", channel.c_str());
        if (reply) freeReplyObject(reply);
    }
}

void RedisClient::startSubscribeLoop() {
    if (running_) return;
    running_ = true;
    subThread_ = std::thread(&RedisClient::subscribeLoop, this);
    LOG_INFO("Redis subscribe loop started");
}

void RedisClient::stopSubscribeLoop() {
    running_ = false;
    if (subThread_.joinable()) {
        subThread_.join();
    }
    LOG_INFO("Redis subscribe loop stopped");
}

void RedisClient::subscribeLoop() {
    while (running_) {
        if (!connected_) {
            LOG_WARN("Redis not connected, attempting reconnect...");
            if (!reconnect()) {
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(kReconnectIntervalMs));
                continue;
            }
        }

        redisReply* reply = nullptr;
        int ret = redisGetReply(subCtx_, (void**)&reply);

        if (ret != REDIS_OK || !reply) {
            LOG_ERROR("Redis subscribe read error, reconnecting...");
            connected_ = false;
            if (reply) freeReplyObject(reply);
            continue;
        }

        // Message format: [type, channel, data]
        if (reply->type == REDIS_REPLY_ARRAY && reply->elements == 3) {
            std::string type    = reply->element[0]->str ? reply->element[0]->str : "";
            std::string channel = reply->element[1]->str ? reply->element[1]->str : "";
            std::string data    = reply->element[2]->str ? reply->element[2]->str : "";

            if (type == "message") {
                handleMessage(channel, data);
            }
        }

        freeReplyObject(reply);
    }
}

bool RedisClient::reconnect() {
    if (pubCtx_) { redisFree(pubCtx_); pubCtx_ = nullptr; }
    if (subCtx_) { redisFree(subCtx_); subCtx_ = nullptr; }

    if (!connect()) return false;

    // Re-subscribe to all channels
    std::lock_guard<std::mutex> lock(callbackMutex_);
    for (auto& [channel, _] : callbacks_) {
        redisReply* reply = (redisReply*)redisCommand(
            subCtx_, "SUBSCRIBE %s", channel.c_str());
        if (reply) freeReplyObject(reply);
        LOG_INFO("Re-subscribed to: " + channel);
    }

    return true;
}

void RedisClient::handleMessage(const std::string& channel, const std::string& message) {
    std::lock_guard<std::mutex> lock(callbackMutex_);
    auto it = callbacks_.find(channel);
    if (it != callbacks_.end()) {
        it->second(channel, message);
    }
}
