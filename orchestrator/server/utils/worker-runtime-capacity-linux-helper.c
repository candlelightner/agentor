/* Read-only candidate tree helper, Linux only. Operator builds and pins this
 * executable; there is no installation, path discovery, quota setter or shell.
 * Protocol is single-flight, bounded tab-delimited commands / canonical JSON
 * lines. Native handles never leave this process. Unsupported symlinks and
 * metadata fail closed, rather than synthesizing XFS/project observations.
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror SOURCE -o OPERATOR_OUTPUT
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <unistd.h>

#define HANDLES 128
#define LINE_BYTES 2048
#define ATTR_BYTES 65536
#define ATTR_TOTAL 1048576
struct entry { int fd; uint64_t token; DIR *dir; uint64_t page; bool listed; };
static struct entry handles[HANDLES];
static uint64_t next_token = 1;
static int proc_fds = -1;
static char attr_names[ATTR_BYTES], attr_value[ATTR_BYTES];
static const char *failure = "adapter";

static void error_reply(void) { printf("{\"ok\":false,\"reason\":\"%s\"}\n", failure); }
static void syscall_failure(void) {
  failure = (errno == ENOSYS || errno == EOPNOTSUPP || errno == ENOTTY || errno == ELOOP ||
             errno == EXDEV || errno == EACCES || errno == EPERM || errno == ENOENT || errno == ENOTDIR) ? "unsupported" :
            errno == ERANGE ? "limit" : "adapter";
}
static bool number(const char *s, uint64_t *out) {
  if (!s || !*s || (s[0] == '0' && s[1])) return false;
  uint64_t n = 0;
  for (; *s; s++) { if (*s < '0' || *s > '9' || n > (UINT64_MAX - (unsigned)(*s - '0')) / 10) return false; n = n * 10 + (unsigned)(*s - '0'); }
  *out = n; return true;
}
static bool component(const char *s) {
  if (!s || !*s || strlen(s) > 255 || !strcmp(s, ".") || !strcmp(s, "..")) return false;
  for (; *s; s++) if ((unsigned char)*s < 32 || (unsigned char)*s == 127 || *s == '/') return false;
  return true;
}
static bool absolute(const char *s) {
  if (!s || s[0] != '/' || !s[1] || strlen(s) > 1024 || s[strlen(s)-1] == '/') return false;
  char copy[1025]; strcpy(copy, s + 1);
  char *start = copy;
  for (char *p = copy; ; p++) if (*p == '/' || !*p) {
    bool end = !*p; *p = 0; if (!component(start)) return false;
    if (end) break;
    start = p + 1;
  }
  return true;
}
static int safe_open(int parent, const char *name, bool root) {
  /* O_PATH first: opening an uncountable device/socket/FIFO must not invoke
   * its I/O callbacks. Once statx proves file/dir, reopen that exact held inode
   * through the helper's pinned procfs fd directory, NEVER its entry name. */
  struct open_how how = { .flags = O_PATH | O_NOFOLLOW | O_CLOEXEC | (root ? O_DIRECTORY : 0),
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
    (root ? 0 : RESOLVE_BENEATH | RESOLVE_NO_XDEV) };
  int pathfd = (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
  if (pathfd < 0) { syscall_failure(); return -1; }
  struct statx sx = {0};
  unsigned required = STATX_TYPE | STATX_MODE | STATX_INO | STATX_MNT_ID;
  if (statx(pathfd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, required, &sx)) {
    syscall_failure(); close(pathfd); return -1;
  }
  if ((sx.stx_mask & required) != required || !sx.stx_ino || !sx.stx_mnt_id ||
      (!S_ISDIR(sx.stx_mode) && !S_ISREG(sx.stx_mode))) { failure = "unsupported"; close(pathfd); return -1; }
  char descriptor[32]; snprintf(descriptor, sizeof(descriptor), "%d", pathfd);
  int fd = openat(proc_fds, descriptor, O_RDONLY | O_NONBLOCK | O_NOATIME | O_CLOEXEC | (S_ISDIR(sx.stx_mode) ? O_DIRECTORY : 0));
  if (fd < 0) syscall_failure();
  else {
    struct statx actual = {0};
    if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, required, &actual)) {
      syscall_failure(); close(fd); fd = -1;
    } else if ((actual.stx_mask & required) != required || actual.stx_ino != sx.stx_ino || actual.stx_mnt_id != sx.stx_mnt_id || actual.stx_mode != sx.stx_mode ||
               actual.stx_dev_major != sx.stx_dev_major || actual.stx_dev_minor != sx.stx_dev_minor) {
      failure = "changed"; close(fd); fd = -1;
    }
  }
  close(pathfd); return fd;
}
static bool observe(int fd, struct statx *sx, struct statfs *sf) {
  memset(sx, 0, sizeof(*sx));
  unsigned mask = STATX_TYPE | STATX_MODE | STATX_NLINK | STATX_INO | STATX_SIZE | STATX_BLOCKS |
    STATX_MTIME | STATX_CTIME | STATX_MNT_ID;
  if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, mask, sx) || fstatfs(fd, sf)) { syscall_failure(); return false; }
  if ((sx->stx_mask & mask) != mask || !sx->stx_ino || !sx->stx_mnt_id || !sx->stx_nlink ||
      (!S_ISDIR(sx->stx_mode) && !S_ISREG(sx->stx_mode))) { failure = "unsupported"; return false; }
  return true;
}
static void fs_identity(const struct statx *sx, const struct statfs *sf, char *result, size_t size) {
  snprintf(result, size, "linuxfs:%u:%u:%08x%08x", sx->stx_dev_major, sx->stx_dev_minor,
    (uint32_t)sf->f_fsid.__val[0], (uint32_t)sf->f_fsid.__val[1]);
}
static struct entry *find(const char *value) {
  uint64_t token; if (!number(value, &token) || !token) { failure = "unsupported"; return NULL; }
  for (int i = 0; i < HANDLES; i++) if (handles[i].fd >= 0 && handles[i].token == token) return &handles[i];
  failure = "unsupported"; return NULL;
}
static struct entry *save(int fd) {
  for (int i = 0; i < HANDLES; i++) if (handles[i].fd < 0) {
    if (next_token == UINT64_MAX) break;
    handles[i] = (struct entry){ .fd = fd, .token = next_token++ }; return &handles[i];
  }
  close(fd); failure = "limit"; return NULL;
}
static bool release(struct entry *e) {
  int fd = e->fd; DIR *dir = e->dir;
  /* Invalidate before close: a failed close never authorizes retry/reuse. */
  e->fd = -1; e->dir = NULL;
  int a = dir ? closedir(dir) : 0, b = close(fd);
  if (a || b) { failure = "adapter"; return false; } return true;
}
static bool time_ns(struct statx_timestamp ts, uint64_t *out) {
  if (ts.tv_sec < 0 || ts.tv_nsec >= 1000000000 || (uint64_t)ts.tv_sec > (UINT64_MAX - ts.tv_nsec) / 1000000000) {
    failure = "unsupported"; return false;
  }
  *out = (uint64_t)ts.tv_sec * 1000000000 + ts.tv_nsec; return true;
}
static bool metadata(int fd, uint64_t *attrs, uint64_t *acls) {
  *attrs = *acls = 0;
  ssize_t count = flistxattr(fd, attr_names, sizeof(attr_names));
  if (count < 0) { syscall_failure(); return false; }
  size_t offset = 0, names = 0;
  while (offset < (size_t)count) {
    size_t length = strnlen(attr_names + offset, (size_t)count - offset);
    if (!length || length >= (size_t)count - offset || ++names > 256) { failure = "limit"; return false; }
    const char *name = attr_names + offset;
    ssize_t bytes = fgetxattr(fd, name, attr_value, sizeof(attr_value));
    if (bytes < 0) { syscall_failure(); return false; }
    uint64_t charge = length + 1 + (uint64_t)bytes;
    if (!strcmp(name, "system.posix_acl_access") || !strcmp(name, "system.posix_acl_default")) *acls += charge;
    else *attrs += charge;
    if (*attrs + *acls > ATTR_TOTAL) { failure = "limit"; return false; }
    offset += length + 1;
  }
  return true;
}
static void quoted(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32 || *p == 127) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static void open_reply(int fd) {
  struct statx sx; struct statfs sf;
  if (!observe(fd, &sx, &sf)) { close(fd); error_reply(); return; }
  struct entry *e = save(fd); if (!e) { error_reply(); return; }
  char fsid[80]; fs_identity(&sx, &sf, fsid, sizeof(fsid));
  printf("{\"handle\":\"%" PRIu64 "\",\"identity\":{\"filesystemId\":\"%s\",\"inode\":\"%" PRIu64
    "\",\"kind\":\"%s\",\"mountId\":\"%" PRIu64 "\"},\"ok\":true}\n",
    e->token, fsid, (uint64_t)sx.stx_ino, S_ISDIR(sx.stx_mode) ? "directory" : "file", (uint64_t)sx.stx_mnt_id);
}
static void stat_reply(struct entry *e) {
  struct statx before, after; struct statfs sf, after_sf; struct fsxattr project = {0}, after_project = {0};
  uint64_t mtime, ctime, attrs, acls;
  if (!observe(e->fd, &before, &sf)) { error_reply(); return; }
  if ((unsigned long)sf.f_type != XFS_SUPER_MAGIC) { failure = "unsupported"; error_reply(); return; }
  if (ioctl(e->fd, FS_IOC_FSGETXATTR, &project)) { syscall_failure(); error_reply(); return; }
  if (!project.fsx_projid || !time_ns(before.stx_mtime, &mtime) || !time_ns(before.stx_ctime, &ctime) ||
      !metadata(e->fd, &attrs, &acls) || !observe(e->fd, &after, &after_sf)) { error_reply(); return; }
  if (ioctl(e->fd, FS_IOC_FSGETXATTR, &after_project)) { syscall_failure(); error_reply(); return; }
  if (before.stx_ino != after.stx_ino || before.stx_mnt_id != after.stx_mnt_id || before.stx_mode != after.stx_mode ||
      before.stx_size != after.stx_size || before.stx_blocks != after.stx_blocks || before.stx_nlink != after.stx_nlink ||
      before.stx_mtime.tv_sec != after.stx_mtime.tv_sec || before.stx_mtime.tv_nsec != after.stx_mtime.tv_nsec ||
      before.stx_ctime.tv_sec != after.stx_ctime.tv_sec || before.stx_ctime.tv_nsec != after.stx_ctime.tv_nsec ||
      sf.f_type != after_sf.f_type || memcmp(&sf.f_fsid, &after_sf.f_fsid, sizeof(sf.f_fsid)) || before.stx_dev_major != after.stx_dev_major ||
      before.stx_dev_minor != after.stx_dev_minor || project.fsx_projid != after_project.fsx_projid ||
      project.fsx_xflags != after_project.fsx_xflags) { failure = "changed"; error_reply(); return; }
  char fsid[80]; fs_identity(&before, &sf, fsid, sizeof(fsid));
  printf("{\"ok\":true,\"value\":{\"aclBytes\":\"%" PRIu64 "\",\"blocks512\":\"%" PRIu64
    "\",\"ctimeNs\":\"%" PRIu64 "\",\"filesystemId\":\"%s\",\"inode\":\"%" PRIu64
    "\",\"kind\":\"%s\",\"links\":\"%u\",\"mountId\":\"%" PRIu64 "\",\"mtimeNs\":\"%" PRIu64 "\",\"projectId\":\"%u\","
    "\"projectInherit\":%s,\"size\":\"%" PRIu64 "\",\"xattrBytes\":\"%" PRIu64 "\"}}\n",
    acls, (uint64_t)before.stx_blocks, ctime, fsid, (uint64_t)before.stx_ino,
    S_ISDIR(before.stx_mode) ? "directory" : "file", before.stx_nlink, (uint64_t)before.stx_mnt_id, mtime, project.fsx_projid,
    (project.fsx_xflags & FS_XFLAG_PROJINHERIT) ? "true" : "false", (uint64_t)before.stx_size, attrs);
}
static bool directory_reply(struct entry *e, const char *cursor, const char *maximum) {
  uint64_t max, page;
  struct statx sx; struct statfs sf;
  if (!number(maximum, &max) || max < 1 || max > 64 || !observe(e->fd, &sx, &sf) || !S_ISDIR(sx.stx_mode)) {
    failure = "unsupported"; return false;
  }
  if (!strcmp(cursor, "-")) {
    if (e->listed) { failure = "unsupported"; return false; }
    int fd = fcntl(e->fd, F_DUPFD_CLOEXEC, 3); if (fd < 0) { syscall_failure(); return false; }
    e->dir = fdopendir(fd); if (!e->dir) { close(fd); syscall_failure(); return false; }
    e->page = 0; e->listed = true;
  } else if (!e->dir || !number(cursor, &page) || page != e->page || !page) { failure = "unsupported"; return false; }
  /* Collect one bounded page before writing a reply. No partial JSON errors. */
  char names[64][256]; size_t count = 0; bool end = false;
  while (count < max) {
    errno = 0; struct dirent *item = readdir(e->dir);
    if (!item) { if (errno) { syscall_failure(); return false; } end = true; break; }
    if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
    if (!component(item->d_name)) { failure = "unsupported"; return false; }
    strcpy(names[count++], item->d_name);
  }
  if (e->page == UINT64_MAX) { failure = "limit"; return false; } e->page++;
  printf("{\"ok\":true,\"value\":{\"names\":[");
  for (size_t i = 0; i < count; i++) { if (i) putchar(','); quoted(names[i]); }
  printf("],\"next\":"); if (end) printf("null"); else printf("\"%" PRIu64 "\"", e->page);
  printf("}}\n"); return true;
}
static bool limits(void) {
  struct rlimit memory = {64 * 1024 * 1024, 64 * 1024 * 1024}, cpu = {5, 5}, files = {256, 256},
    writes = {0, 0}, core = {0, 0};
  return !setrlimit(RLIMIT_AS, &memory) && !setrlimit(RLIMIT_CPU, &cpu) && !setrlimit(RLIMIT_NOFILE, &files) &&
    !setrlimit(RLIMIT_FSIZE, &writes) && !setrlimit(RLIMIT_CORE, &core) && !prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
}
int main(void) {
  for (int i = 0; i < HANDLES; i++) handles[i].fd = -1;
  if (!limits()) return 2;
  /* Only inherited stdin/out/err survive setup; executable fd3 is not retained. */
  if (syscall(SYS_close_range, 3U, ~0U, 0U)) return 2;
  struct open_how proc_how = { .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  int proc = (int)syscall(SYS_openat2, AT_FDCWD, "/proc", &proc_how, sizeof(proc_how));
  struct statfs proc_fs;
  if (proc < 0 || fstatfs(proc, &proc_fs) || (unsigned long)proc_fs.f_type != PROC_SUPER_MAGIC) return 2;
  /* The only followed link is kernel procfs self/fd for this exact process. */
  proc_fds = openat(proc, "self/fd", O_PATH | O_DIRECTORY | O_CLOEXEC);
  close(proc); if (proc_fds < 0) return 2;
  char line[LINE_BYTES];
  while (fgets(line, sizeof(line), stdin)) {
    size_t length = strlen(line);
    if (!length || line[length-1] != '\n') { failure = "limit"; error_reply(); break; }
    line[length-1] = 0; failure = "unsupported";
    char *fields[5] = {0}, *start = line; size_t count = 0;
    for (char *p = line; ; p++) if (*p == '\t' || !*p) {
      bool end = !*p; *p = 0; if (count == 5) break; fields[count++] = start;
      if (end) break;
      start = p + 1;
    }
    if (count == 1 && !strcmp(fields[0], "PING")) printf("{\"ok\":true,\"version\":1}\n");
    else if (count == 1 && !strcmp(fields[0], "QUIT")) { printf("{\"ok\":true}\n"); fflush(stdout); break; }
    else if (count == 2 && !strcmp(fields[0], "ROOT") && absolute(fields[1])) {
      int fd = safe_open(AT_FDCWD, fields[1], true); if (fd < 0) error_reply(); else open_reply(fd);
    } else if (count >= 2) {
      struct entry *e = find(fields[1]);
      if (!e) error_reply();
      else if (count == 3 && !strcmp(fields[0], "CHILD") && component(fields[2])) {
        int fd = safe_open(e->fd, fields[2], false); if (fd < 0) error_reply(); else {
          struct statx a, b; struct statfs as, bs;
          if (!observe(e->fd, &a, &as) || !observe(fd, &b, &bs)) { close(fd); error_reply(); }
          else if (a.stx_mnt_id != b.stx_mnt_id || a.stx_dev_major != b.stx_dev_major || a.stx_dev_minor != b.stx_dev_minor ||
                   memcmp(&as.f_fsid, &bs.f_fsid, sizeof(as.f_fsid))) { close(fd); failure = "changed"; error_reply(); }
          else open_reply(fd);
        }
      } else if (count == 2 && !strcmp(fields[0], "STAT")) stat_reply(e);
      else if (count == 4 && !strcmp(fields[0], "DIR")) { if (!directory_reply(e, fields[2], fields[3])) error_reply(); }
      else if (count == 2 && !strcmp(fields[0], "CLOSE")) {
        if (release(e)) printf("{\"ok\":true}\n"); else { error_reply(); fflush(stdout); break; }
      } else error_reply();
    } else error_reply();
    if (fflush(stdout)) break;
  }
  for (int i = 0; i < HANDLES; i++) if (handles[i].fd >= 0) release(&handles[i]);
  close(proc_fds);
  return 0;
}
