/*
 * libsandbox.c — LD_PRELOAD library for cross-session filesystem isolation.
 *
 * Intercepts glibc open/openat/stat/lstat/access/faccessat/chdir/rename/
 * unlink/mkdir/rmdir to enforce path-based access control. Loaded via
 * LD_PRELOAD into the Claude CLI process and all its children (Bash
 * commands, python3, git, etc.).
 *
 * Policy (read from env at first call):
 *   SANDBOX_SESSION_ROOT  — allowed prefix under /data/sessions/ (the
 *                           session's base dir, e.g. /data/sessions/telegram/dm/12345).
 *                           Both home/ and workdir/ are under this prefix.
 *
 * Rules:
 *   1. Path starts with /data/sessions/  → allow only if under SANDBOX_SESSION_ROOT
 *   2. Path starts with /data/user_context → allow (context MCP)
 *   3. Path is exactly /data/sessions-index.json → allow
 *   3b. Path is a platform-internal secret (/config/secrets/agent-platform-key
 *       or /config/secrets/cron-trigger-key) → DENY. These are the
 *       workspace's Agent-Platform-API key and the loopback cron/internal
 *       HMAC key. They're consumed server-side by the MCP/chat-server and
 *       must never be readable from the model-driven shell — otherwise a
 *       prompt-injected turn could exfiltrate the API key (full workspace
 *       backend access) or forge /internal/* and /cron requests, defeating
 *       the loopback + X-Internal-Key boundary. Mirrors
 *       agent_platform_mcp.SECRET_SYSTEM_BASENAMES. Workspace *integration*
 *       secrets under /config/secrets/ (notion-token, custom-*, etc.) stay
 *       readable — the agent is meant to use those in commands.
 *   4. Everything else → allow (system paths, /usr, /app, /config/, etc.)
 *
 * Compile: gcc -shared -fPIC -o libsandbox.so libsandbox.c -ldl
 */

#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static const char *session_root = NULL;
static size_t session_root_len = 0;
static int initialized = 0;

/* Forward declaration — check_at_path calls check_path. */
static int check_path(const char *path);

/*
 * Platform-internal secret files the model-driven shell must never read.
 * These are NOT workspace integrations — they're the workspace's
 * Agent-Platform-API key and the loopback cron/internal HMAC key, used
 * server-side by the MCP + chat-server. Mirrors
 * agent_platform_mcp.SECRET_SYSTEM_BASENAMES. Compared against the
 * realpath-resolved path so /config/secrets/../secrets/... and symlink
 * tricks can't slip past.
 */
static const char *const DENIED_SECRETS[] = {
    "/config/secrets/agent-platform-key",
    "/config/secrets/cron-trigger-key",
};

static int is_denied_secret(const char *resolved) {
    for (size_t i = 0; i < sizeof(DENIED_SECRETS) / sizeof(DENIED_SECRETS[0]); i++) {
        if (strcmp(resolved, DENIED_SECRETS[i]) == 0) return 1;
    }
    return 0;
}

static void ensure_init(void) {
    if (initialized) return;
    initialized = 1;
    const char *val = getenv("SANDBOX_SESSION_ROOT");
    if (val && val[0] == '/') {
        session_root = val;
        session_root_len = strlen(val);
    }
}

/*
 * Resolve a dirfd + relative path into an absolute path for checking.
 * Returns 1 and fills `out` (up to outlen) on success; 0 on failure.
 * Used by all *at() interceptors to close the relative-path bypass
 * where an attacker opens("/") → fd, then openat(fd, "data/sessions/other/...").
 */
static int resolve_dirfd_path(int dirfd, const char *path, char *out, size_t outlen) {
    char fd_link[64];
    char fd_path[PATH_MAX];
    snprintf(fd_link, sizeof(fd_link), "/proc/self/fd/%d", dirfd);
    ssize_t len = readlink(fd_link, fd_path, PATH_MAX - 1);
    if (len <= 0) return 0;
    fd_path[len] = '\0';
    size_t need = (size_t)len + 1 + strlen(path) + 1;
    if (need > outlen) return 0;
    snprintf(out, outlen, "%s/%s", fd_path, path);
    return 1;
}

/*
 * Check an *at()-style call: if the path is absolute, check it directly.
 * If relative and dirfd != AT_FDCWD, resolve via /proc/self/fd/ and check.
 * Returns 0 if allowed, -1 if denied.
 */
static int check_at_path(int dirfd, const char *path) {
    if (!path) return 0;
    if (path[0] == '/') return check_path(path);
    if (dirfd == AT_FDCWD) return check_path(path);
    /* Relative path with an explicit dirfd — resolve to absolute. */
    char combined[PATH_MAX];
    if (resolve_dirfd_path(dirfd, path, combined, sizeof(combined)))
        return check_path(combined);
    /* Can't resolve dirfd. Fail-closed for /data/sessions/ patterns: if the
     * relative path textually contains "sessions" we deny rather than guess. */
    if (strstr(path, "sessions"))  {
        errno = EACCES;
        return -1;
    }
    return 0;
}

/*
 * Check whether `path` is allowed. Returns 0 if allowed, -1 if denied.
 * When denied, sets errno to EACCES.
 */
static int check_path(const char *path) {
    if (!path) return 0;
    ensure_init();
    if (!session_root) return 0;  /* no root configured → allow all */

    /* Resolve symlinks + relative components so ../.. tricks don't bypass. */
    char resolved[PATH_MAX];
    if (realpath(path, resolved) == NULL) {
        /* If the file doesn't exist yet (e.g. open with O_CREAT), resolve
         * the parent directory instead. */
        char tmp[PATH_MAX];
        strncpy(tmp, path, PATH_MAX - 1);
        tmp[PATH_MAX - 1] = '\0';
        /* Find last slash */
        char *slash = strrchr(tmp, '/');
        if (slash && slash != tmp) {
            *slash = '\0';
            if (realpath(tmp, resolved) == NULL) {
                /* Can't resolve parent. Fail-closed if the raw path looks
                 * like it targets /data/sessions/ — deny rather than guess. */
                if (strncmp(path, "/data/sessions/", 15) == 0 ||
                    strncmp(path, "/data/sessions", 14) == 0) {
                    errno = EACCES;
                    return -1;
                }
                return 0;
            }
            /* Append the filename back */
            size_t rlen = strlen(resolved);
            size_t flen = strlen(slash + 1);
            if (rlen + 1 + flen < PATH_MAX) {
                resolved[rlen] = '/';
                memcpy(resolved + rlen + 1, slash + 1, flen + 1);
            }
        } else {
            /* No slash — relative single-component name. Allow (can't be
             * an absolute /data/sessions path). */
            return 0;
        }
    }

    /* Rule 1: /data/sessions or /data/sessions/* → must be under session_root.
     * Compare against "/data/sessions" (14 chars) and check the next char is
     * '/' or '\0' so that "/data/sessions-index.json" (rule 3) doesn't
     * accidentally match here. */
    if (strncmp(resolved, "/data/sessions", 14) == 0 &&
        (resolved[14] == '/' || resolved[14] == '\0')) {
        if (strncmp(resolved, session_root, session_root_len) == 0 &&
            (resolved[session_root_len] == '/' ||
             resolved[session_root_len] == '\0')) {
            return 0;  /* under session root → allowed */
        }
        errno = EACCES;
        return -1;  /* other session → denied */
    }

    /* Rule 2: /data/user_context → allow */
    if (strncmp(resolved, "/data/user_context", 18) == 0)
        return 0;

    /* Rule 3: /data/sessions-index.json → allow */
    if (strcmp(resolved, "/data/sessions-index.json") == 0)
        return 0;

    /* Rule 3b: platform-internal secrets → deny (see DENIED_SECRETS). The
     * agent reaches the backend through its MCP (which reads the key
     * server-side), never the raw key from a shell — so denying these
     * keeps the loopback/internal-key boundary meaningful even against a
     * prompt-injected turn, while leaving integration secrets readable. */
    if (is_denied_secret(resolved)) {
        errno = EACCES;
        return -1;
    }

    /* Rule 4: everything else → allow (including the rest of /config/,
     * mounted read-only — the agent already operates under those
     * credentials and is meant to use integration secrets in commands) */
    return 0;
}

/* ---- Intercepted functions ---- */

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);
typedef int (*stat_fn)(const char *, struct stat *);
typedef int (*lstat_fn)(const char *, struct stat *);
typedef int (*access_fn)(const char *, int);
typedef int (*faccessat_fn)(int, const char *, int, int);
typedef int (*chdir_fn)(const char *);
typedef int (*rename_fn)(const char *, const char *);
typedef int (*unlink_fn)(const char *);
typedef int (*mkdir_fn)(const char *, mode_t);
typedef int (*rmdir_fn)(const char *);
typedef FILE *(*fopen_fn)(const char *, const char *);

int open(const char *path, int flags, ...) {
    if (check_path(path) != 0) return -1;
    open_fn real = (open_fn)dlsym(RTLD_NEXT, "open");
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(path, flags, mode);
    }
    return real(path, flags);
}

int open64(const char *path, int flags, ...) {
    if (check_path(path) != 0) return -1;
    open_fn real = (open_fn)dlsym(RTLD_NEXT, "open64");
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(path, flags, mode);
    }
    return real(path, flags);
}

int openat(int dirfd, const char *path, int flags, ...) {
    if (check_at_path(dirfd, path) != 0) return -1;
    openat_fn real = (openat_fn)dlsym(RTLD_NEXT, "openat");
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(dirfd, path, flags, mode);
    }
    return real(dirfd, path, flags);
}

int __xstat(int ver, const char *path, struct stat *buf) {
    if (check_path(path) != 0) return -1;
    int (*real)(int, const char *, struct stat *) =
        dlsym(RTLD_NEXT, "__xstat");
    return real(ver, path, buf);
}

int __lxstat(int ver, const char *path, struct stat *buf) {
    if (check_path(path) != 0) return -1;
    int (*real)(int, const char *, struct stat *) =
        dlsym(RTLD_NEXT, "__lxstat");
    return real(ver, path, buf);
}

int stat(const char *path, struct stat *buf) {
    if (check_path(path) != 0) return -1;
    stat_fn real = (stat_fn)dlsym(RTLD_NEXT, "stat");
    return real(path, buf);
}

int lstat(const char *path, struct stat *buf) {
    if (check_path(path) != 0) return -1;
    lstat_fn real = (lstat_fn)dlsym(RTLD_NEXT, "lstat");
    return real(path, buf);
}

int access(const char *path, int mode) {
    if (check_path(path) != 0) return -1;
    access_fn real = (access_fn)dlsym(RTLD_NEXT, "access");
    return real(path, mode);
}

int faccessat(int dirfd, const char *path, int mode, int flags) {
    if (check_at_path(dirfd, path) != 0) return -1;
    faccessat_fn real = (faccessat_fn)dlsym(RTLD_NEXT, "faccessat");
    return real(dirfd, path, mode, flags);
}

int chdir(const char *path) {
    if (check_path(path) != 0) return -1;
    chdir_fn real = (chdir_fn)dlsym(RTLD_NEXT, "chdir");
    return real(path);
}

int rename(const char *oldpath, const char *newpath) {
    if (check_path(oldpath) != 0) return -1;
    if (check_path(newpath) != 0) return -1;
    rename_fn real = (rename_fn)dlsym(RTLD_NEXT, "rename");
    return real(oldpath, newpath);
}

int unlink(const char *path) {
    if (check_path(path) != 0) return -1;
    unlink_fn real = (unlink_fn)dlsym(RTLD_NEXT, "unlink");
    return real(path);
}

int mkdir(const char *path, mode_t mode) {
    if (check_path(path) != 0) return -1;
    mkdir_fn real = (mkdir_fn)dlsym(RTLD_NEXT, "mkdir");
    return real(path, mode);
}

int rmdir(const char *path) {
    if (check_path(path) != 0) return -1;
    rmdir_fn real = (rmdir_fn)dlsym(RTLD_NEXT, "rmdir");
    return real(path);
}

FILE *fopen(const char *path, const char *mode) {
    if (check_path(path) != 0) return NULL;
    fopen_fn real = (fopen_fn)dlsym(RTLD_NEXT, "fopen");
    return real(path, mode);
}

FILE *fopen64(const char *path, const char *mode) {
    if (check_path(path) != 0) return NULL;
    fopen_fn real = (fopen_fn)dlsym(RTLD_NEXT, "fopen64");
    return real(path, mode);
}

/* ---- *at() family: used by coreutils (rm, mv, chmod, ln) instead of
 *      the legacy single-path versions ---- */

int unlinkat(int dirfd, const char *path, int flags) {
    if (check_at_path(dirfd, path) != 0) return -1;
    int (*real)(int, const char *, int) = dlsym(RTLD_NEXT, "unlinkat");
    return real(dirfd, path, flags);
}

int renameat(int olddirfd, const char *oldpath,
             int newdirfd, const char *newpath) {
    if (check_at_path(olddirfd, oldpath) != 0) return -1;
    if (check_at_path(newdirfd, newpath) != 0) return -1;
    int (*real)(int, const char *, int, const char *) =
        dlsym(RTLD_NEXT, "renameat");
    return real(olddirfd, oldpath, newdirfd, newpath);
}

int renameat2(int olddirfd, const char *oldpath,
              int newdirfd, const char *newpath, unsigned int flags) {
    if (check_at_path(olddirfd, oldpath) != 0) return -1;
    if (check_at_path(newdirfd, newpath) != 0) return -1;
    int (*real)(int, const char *, int, const char *, unsigned int) =
        dlsym(RTLD_NEXT, "renameat2");
    return real(olddirfd, oldpath, newdirfd, newpath, flags);
}

int symlink(const char *target, const char *linkpath) {
    if (linkpath && linkpath[0] == '/')
        if (check_path(linkpath) != 0) return -1;
    int (*real)(const char *, const char *) = dlsym(RTLD_NEXT, "symlink");
    return real(target, linkpath);
}

int symlinkat(const char *target, int newdirfd, const char *linkpath) {
    if (check_at_path(newdirfd, linkpath) != 0) return -1;
    int (*real)(const char *, int, const char *) =
        dlsym(RTLD_NEXT, "symlinkat");
    return real(target, newdirfd, linkpath);
}

int link(const char *oldpath, const char *newpath) {
    if (oldpath && oldpath[0] == '/')
        if (check_path(oldpath) != 0) return -1;
    if (newpath && newpath[0] == '/')
        if (check_path(newpath) != 0) return -1;
    int (*real)(const char *, const char *) = dlsym(RTLD_NEXT, "link");
    return real(oldpath, newpath);
}

int linkat(int olddirfd, const char *oldpath,
           int newdirfd, const char *newpath, int flags) {
    if (check_at_path(olddirfd, oldpath) != 0) return -1;
    if (check_at_path(newdirfd, newpath) != 0) return -1;
    int (*real)(int, const char *, int, const char *, int) =
        dlsym(RTLD_NEXT, "linkat");
    return real(olddirfd, oldpath, newdirfd, newpath, flags);
}

int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    if (check_at_path(dirfd, path) != 0) return -1;
    int (*real)(int, const char *, mode_t, int) =
        dlsym(RTLD_NEXT, "fchmodat");
    return real(dirfd, path, mode, flags);
}

int chmod(const char *path, mode_t mode) {
    if (check_path(path) != 0) return -1;
    int (*real)(const char *, mode_t) = dlsym(RTLD_NEXT, "chmod");
    return real(path, mode);
}

/* ---- opendir / scandir: fix the directory-listing leak ---- */

typedef DIR *(*opendir_fn)(const char *);
typedef int (*scandir_fn)(const char *, struct dirent ***,
                          int (*)(const struct dirent *),
                          int (*)(const struct dirent **, const struct dirent **));

DIR *opendir(const char *name) {
    if (check_path(name) != 0) return NULL;
    opendir_fn real = (opendir_fn)dlsym(RTLD_NEXT, "opendir");
    return real(name);
}

int scandir(const char *dirp, struct dirent ***namelist,
            int (*filter)(const struct dirent *),
            int (*compar)(const struct dirent **, const struct dirent **)) {
    if (check_path(dirp) != 0) return -1;
    scandir_fn real = (scandir_fn)dlsym(RTLD_NEXT, "scandir");
    return real(dirp, namelist, filter, compar);
}

/* ---- execve / execveat: block execution of binaries from /data/ ---- */
/*
 * Prevents a prompt-injected model from downloading a statically-linked
 * binary to the EFS workspace and executing it (which would bypass
 * LD_PRELOAD entirely). Only blocks exec of paths that resolve under
 * /data/ — system binaries (/usr/bin/python3, /usr/bin/git, etc.) are
 * allowed. This is best-effort: a static binary that's already running
 * can fork+exec via raw syscall, but that requires getting code execution
 * without exec first, which is a much harder attack.
 */

static int check_exec_path(const char *path) {
    if (!path) return 0;
    ensure_init();
    if (!session_root) return 0;

    char resolved[PATH_MAX];
    if (realpath(path, resolved) == NULL)
        return 0;  /* can't resolve — let the real execve fail naturally */

    if (strncmp(resolved, "/data/", 6) == 0) {
        errno = EACCES;
        return -1;
    }
    return 0;
}

typedef int (*execve_fn)(const char *, char *const[], char *const[]);

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    if (check_exec_path(pathname) != 0) return -1;
    execve_fn real = (execve_fn)dlsym(RTLD_NEXT, "execve");
    return real(pathname, argv, envp);
}

int execveat(int dirfd, const char *pathname, char *const argv[],
             char *const envp[], int flags) {
    /* Absolute path or AT_EMPTY_PATH with dirfd — check directly. */
    if (pathname && pathname[0] == '/') {
        if (check_exec_path(pathname) != 0) return -1;
    } else if (pathname && pathname[0] != '\0' && dirfd != AT_FDCWD) {
        /* Relative path with dirfd — resolve via /proc/self/fd/. */
        char combined[PATH_MAX];
        if (resolve_dirfd_path(dirfd, pathname, combined, sizeof(combined))) {
            if (check_exec_path(combined) != 0) return -1;
        }
    } else if (pathname) {
        /* Relative to cwd — resolve normally. */
        if (check_exec_path(pathname) != 0) return -1;
    }
    int (*real)(int, const char *, char *const[], char *const[], int) =
        dlsym(RTLD_NEXT, "execveat");
    return real(dirfd, pathname, argv, envp, flags);
}

/* Also intercept fexecve, which execs an already-open fd. Check via
 * /proc/self/fd/ to see what file the fd points to. */
int fexecve(int fd, char *const argv[], char *const envp[]) {
    ensure_init();
    if (session_root) {
        char fd_link[64];
        char fd_path[PATH_MAX];
        snprintf(fd_link, sizeof(fd_link), "/proc/self/fd/%d", fd);
        ssize_t len = readlink(fd_link, fd_path, PATH_MAX - 1);
        if (len > 0) {
            fd_path[len] = '\0';
            if (check_exec_path(fd_path) != 0) return -1;
        }
    }
    int (*real)(int, char *const[], char *const[]) =
        dlsym(RTLD_NEXT, "fexecve");
    return real(fd, argv, envp);
}


/* ---- posix_spawn / posix_spawnp: Python 3.12+ subprocess uses these
 *      instead of fork+execve, bypassing the execve hook. ---- */

#include <spawn.h>

typedef int (*posix_spawn_fn)(pid_t *, const char *,
                              const posix_spawn_file_actions_t *,
                              const posix_spawnattr_t *,
                              char *const[], char *const[]);

static int _sandbox_posix_spawn(pid_t *pid, const char *path,
                                const posix_spawn_file_actions_t *fa,
                                const posix_spawnattr_t *attrp,
                                char *const argv[], char *const envp[]) {
    if (check_exec_path(path) != 0) return EACCES;
    posix_spawn_fn real = (posix_spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
    return real(pid, path, fa, attrp, argv, envp);
}

static int _sandbox_posix_spawnp(pid_t *pid, const char *file,
                                 const posix_spawn_file_actions_t *fa,
                                 const posix_spawnattr_t *attrp,
                                 char *const argv[], char *const envp[]) {
    if (file && (file[0] == '/' || strchr(file, '/')))
        if (check_exec_path(file) != 0) return EACCES;
    posix_spawn_fn real = (posix_spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");
    return real(pid, file, fa, attrp, argv, envp);
}

/* Export as the default symbol. This catches callers that link against
 * the unversioned posix_spawn (e.g. programs compiled against older glibc).
 * CPython links against posix_spawn@GLIBC_2.15, which the dynamic linker
 * resolves directly to glibc — LD_PRELOAD cannot override versioned symbols.
 * For CPython's subprocess, the exec restriction is enforced by the
 * confined-bash wrapper (which blocks chmod +x and execution from /data/)
 * and by the execve/SYS_execve hooks (which catch fork+exec codepaths). */
int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[])
    __attribute__((alias("_sandbox_posix_spawn")));

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[])
    __attribute__((alias("_sandbox_posix_spawnp")));


/* ---- syscall(): catch ctypes.CDLL(None).syscall() ---- */

typedef long (*syscall_fn)(long, ...);

long syscall(long number, ...) {
    syscall_fn real = (syscall_fn)dlsym(RTLD_NEXT, "syscall");
    va_list ap;
    va_start(ap, number);

    switch (number) {
#ifdef SYS_open
        /* SYS_open is x86_64-only; arm64/riscv64 glibc routes open()
         * through openat(AT_FDCWD, ...), so this case is unused there. */
        case SYS_open: {
            const char *path = va_arg(ap, const char *);
            int flags = va_arg(ap, int);
            va_end(ap);
            if (check_path(path) != 0) return -1;
            return real(number, path, flags);
        }
#endif
        case SYS_openat: {
            int dirfd = va_arg(ap, int);
            const char *path = va_arg(ap, const char *);
            int flags = va_arg(ap, int);
            va_end(ap);
            if (check_at_path(dirfd, path) != 0) return -1;
            return real(number, dirfd, path, flags);
        }
#ifdef SYS_stat
        case SYS_stat:
#endif
#ifdef SYS_lstat
        case SYS_lstat:
#endif
        {
            const char *path = va_arg(ap, const char *);
            void *buf = va_arg(ap, void *);
            va_end(ap);
            if (check_path(path) != 0) return -1;
            return real(number, path, buf);
        }
        /* SYS_newfstatat (fstatat64): modern glibc routes stat() through
         * fstatat(AT_FDCWD, ...) internally. Must handle dirfd. */
#ifdef SYS_newfstatat
        case SYS_newfstatat: {
            int dirfd = va_arg(ap, int);
            const char *path = va_arg(ap, const char *);
            void *buf = va_arg(ap, void *);
            int flags = va_arg(ap, int);
            va_end(ap);
            if (check_at_path(dirfd, path) != 0) return -1;
            return real(number, dirfd, path, buf, flags);
        }
#endif
#ifdef SYS_statx
        /* SYS_statx: newer stat variant (Linux 4.11+). */
        case SYS_statx: {
            int dirfd = va_arg(ap, int);
            const char *path = va_arg(ap, const char *);
            int flags = va_arg(ap, int);
            unsigned int mask = va_arg(ap, unsigned int);
            void *buf = va_arg(ap, void *);
            va_end(ap);
            if (check_at_path(dirfd, path) != 0) return -1;
            return real(number, dirfd, path, flags, mask, buf);
        }
#endif
#ifdef SYS_access
        /* SYS_access is x86_64-only; arm64/riscv64 use faccessat. */
        case SYS_access: {
            const char *path = va_arg(ap, const char *);
            int mode = va_arg(ap, int);
            va_end(ap);
            if (check_path(path) != 0) return -1;
            return real(number, path, mode);
        }
#endif
#ifdef SYS_unlink
        case SYS_unlink:
#endif
#ifdef SYS_rmdir
        case SYS_rmdir:
#endif
        case SYS_chdir: {
            const char *path = va_arg(ap, const char *);
            va_end(ap);
            if (check_path(path) != 0) return -1;
            return real(number, path);
        }
        case SYS_unlinkat: {
            int dirfd = va_arg(ap, int);
            const char *path = va_arg(ap, const char *);
            int flags = va_arg(ap, int);
            va_end(ap);
            if (check_at_path(dirfd, path) != 0) return -1;
            return real(number, dirfd, path, flags);
        }
        case SYS_execve: {
            const char *path = va_arg(ap, const char *);
            char **argv = va_arg(ap, char **);
            char **envp = va_arg(ap, char **);
            va_end(ap);
            if (check_exec_path(path) != 0) return -1;
            return real(number, path, argv, envp);
        }
        case SYS_execveat: {
            int dirfd = va_arg(ap, int);
            const char *path = va_arg(ap, const char *);
            char **argv = va_arg(ap, char **);
            char **envp = va_arg(ap, char **);
            int flags = va_arg(ap, int);
            va_end(ap);
            if (path && path[0] == '/') {
                if (check_exec_path(path) != 0) return -1;
            } else if (path && dirfd != AT_FDCWD) {
                char combined[PATH_MAX];
                if (resolve_dirfd_path(dirfd, path, combined, sizeof(combined)))
                    if (check_exec_path(combined) != 0) return -1;
            } else if (path) {
                if (check_exec_path(path) != 0) return -1;
            }
            return real(number, dirfd, path, argv, envp, flags);
        }
#ifdef SYS_getdents
        /* SYS_getdents is x86_64-only; arm64/riscv64 only have getdents64. */
        case SYS_getdents:
#endif
        case SYS_getdents64: {
            int fd = va_arg(ap, int);
            void *dirp = va_arg(ap, void *);
            unsigned int count = va_arg(ap, unsigned int);
            va_end(ap);
            return real(number, fd, dirp, count);
        }
        default: {
            long a1 = va_arg(ap, long);
            long a2 = va_arg(ap, long);
            long a3 = va_arg(ap, long);
            long a4 = va_arg(ap, long);
            long a5 = va_arg(ap, long);
            long a6 = va_arg(ap, long);
            va_end(ap);
            return real(number, a1, a2, a3, a4, a5, a6);
        }
    }
}
