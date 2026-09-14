#pragma once

#include <memory>
#include <string>
#include <string_view>
#include <utility>

#include <fmt/format.h>

namespace spdlog {

namespace level {
enum level_enum {
    trace,
    debug,
    info,
    warn,
    err,
    critical,
    off,
    n_levels
};
} // namespace level

struct source_loc {
    const char *filename = nullptr;
    int line = 0;
    const char *funcname = nullptr;

    constexpr source_loc() = default;
    constexpr source_loc(const char *filename_, int line_,
                         const char *funcname_) noexcept :
        filename(filename_), line(line_), funcname(funcname_) {}
};

template <typename... Args>
using format_string_t = fmt::format_string<Args...>;

class logger {
public:
    logger() = default;
    explicit logger(std::string) {}

    template <typename... Args>
    void trace(Args &&...) noexcept {}

    template <typename... Args>
    void debug(Args &&...) noexcept {}

    template <typename... Args>
    void info(Args &&...) noexcept {}

    template <typename... Args>
    void warn(Args &&...) noexcept {}

    template <typename... Args>
    void error(Args &&...) noexcept {}

    template <typename... Args>
    void critical(Args &&...) noexcept {}

    template <typename... Args>
    void log(Args &&...) noexcept {}

    void set_level(level::level_enum) noexcept {}
    void flush() noexcept {}
};

inline std::shared_ptr<logger> default_logger() {
    static auto instance = std::make_shared<logger>("stub");
    return instance;
}

inline std::shared_ptr<logger> get(std::string_view) {
    return default_logger();
}

inline std::shared_ptr<logger> stdout_color_mt(const std::string &) {
    return default_logger();
}

inline std::shared_ptr<logger> stdout_color_st(const std::string &) {
    return default_logger();
}

inline std::shared_ptr<logger> stderr_color_mt(const std::string &) {
    return default_logger();
}

inline std::shared_ptr<logger> stderr_color_st(const std::string &) {
    return default_logger();
}

inline void set_default_logger(std::shared_ptr<logger>) noexcept {}
inline void set_level(level::level_enum) noexcept {}
inline void set_pattern(std::string_view) noexcept {}
inline void drop_all() noexcept {}

template <typename... Args>
inline void trace(Args &&...) noexcept {}

template <typename... Args>
inline void debug(Args &&...) noexcept {}

template <typename... Args>
inline void info(Args &&...) noexcept {}

template <typename... Args>
inline void warn(Args &&...) noexcept {}

template <typename... Args>
inline void error(Args &&...) noexcept {}

template <typename... Args>
inline void critical(Args &&...) noexcept {}

} // namespace spdlog
