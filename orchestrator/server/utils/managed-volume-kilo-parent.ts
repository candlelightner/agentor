/** Only the historical XDG parent may contain this one canonical external link. */
export const MANAGED_KILO_PARENT = '/home/agent/.local/share';
export const MANAGED_KILO_LINK = '/home/agent/.agent-data/.kilo/shared-data';

export const MANAGED_KILO_PARENT_CHECK = String.raw`
import os,stat,sys
root=sys.argv[1]
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
 for name in root[1:].split('/'):
  nextfd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd);fd=nextfd
 before=os.stat('kilo',dir_fd=fd,follow_symlinks=False)
 if not stat.S_ISLNK(before.st_mode) or os.readlink('kilo',dir_fd=fd)!="/home/agent/.agent-data/.kilo/shared-data":
  raise ValueError('Managed XDG parent requires the canonical Kilo symlink')
 after=os.stat('kilo',dir_fd=fd,follow_symlinks=False)
 if (before.st_dev,before.st_ino,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_ctime_ns):
  raise ValueError('Managed Kilo symlink changed during validation')
finally: os.close(fd)
`;
