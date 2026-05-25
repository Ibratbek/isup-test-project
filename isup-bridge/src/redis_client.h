#pragma once

#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <mutex>
#include <unordered_map>

// Forward declare hiredis types to avoid including in header
struct redisContext;
struct redisAsyncContext;

using MessageCallback = std::function<void(const std::string& channel, const std::string& message)>;

class RedisClient {
public:
    RedisClient(const std::string& host, int port);
    ~RedisClient();

    // Non-copyable
    RedisClient(const RedisClient&) = delete;
    RedisClient& operator=(const RedisClient&) = delete;

    bool connect();
    void disconnect();
    bool isConnected() const;

    // Publish a message to a channel
    bool publish(const std::string& channel, const std::string& message);

    // Subscribe to a channel with a callback
    bool subscribe(const std::string& channel, MessageCallback callback);
    void unsubscribe(const std::string& channel);

    // Start the subscribe event loop in a background thread
    void startSubscribeLoop();
    void stopSubscribeLoop();

private:
    void subscribeLoop();
    bool reconnect();
    void handleMessage(const std::string& channel, const std::string& message);

    std::string host_;
    int port_;

    // Separate contexts for pub and sub (hiredis requirement)
    redisContext* pubCtx_  = nullptr;
    redisContext* subCtx_  = nullptr;

    std::unordered_map<std::string, MessageCallback> callbacks_;
    std::mutex callbackMutex_;
    std::mutex pubMutex_;

    std::thread subThread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};

    static constexpr int kReconnectIntervalMs = 3000;
};
