# Home/package restoration is enabled only after migration has committed. This
# avoids interrupting package installation when migration restores stopped intent.
if [ -f /home/agent/.agent-data/.incus-migration-home/enabled ]; then
    python3 /home/agent/.agent-data/.incus-migration-home/restore-worker-home.py || exit $?
fi

