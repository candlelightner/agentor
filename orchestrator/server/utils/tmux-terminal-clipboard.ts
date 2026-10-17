/** Enable application OSC 52 forwarding to xterm clients. Existing terminal
 * features are retained; repeated attachments do not append the capability
 * again. Browser handling requires an explicit operator copy action. */
export const TMUX_TERMINAL_CLIPBOARD_SETUP =
  'tmux set-option -s set-clipboard on && ' +
  '(tmux show-option -sv terminal-features | grep -Fq "xterm*:clipboard" || tmux set-option -as terminal-features ",xterm*:clipboard") && ';
