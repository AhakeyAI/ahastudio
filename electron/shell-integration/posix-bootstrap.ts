import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from './bash-prompt-command-composition.js';

/**
 * Generates the Bash --rcfile wrapper script emitting OSC 7 CWD and OSC 133 A/C/D
 * while preserving user login profiles, rc files, PROMPT_COMMAND arrays/scalars, and DEBUG traps.
 */
export function getBashIntegrationRcfileContent(): string {
  return `# Ahastation interactive bash shell integration wrapper
if [[ -f /etc/profile ]]; then
  source /etc/profile
fi
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
elif [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null || true

__aha_osc7_cwd_report() {
  if [[ "$PWD" != "\${__aha_osc7_last_pwd-}" ]]; then
    __aha_osc7_last_pwd=$PWD
    local LC_ALL=C __aha_e="" __aha_c __aha_i
    for (( __aha_i = 0; __aha_i < \${#PWD}; __aha_i++ )); do
      __aha_c=\${PWD:__aha_i:1}
      case $__aha_c in
        [A-Za-z0-9/._~-]) __aha_e+=$__aha_c ;;
        *) printf -v __aha_c '%d' "'$__aha_c"; printf -v __aha_c '%%%02X' $(( __aha_c & 255 )); __aha_e+=$__aha_c ;;
      esac
    done
    __aha_osc7_encoded=$__aha_e
  fi
  printf '\\033]7;file://%s\\007' "\${__aha_osc7_encoded-}"
}

__orca_initializing_wrapper=1
__orca_osc133_precmd() {
  local exit_code=$?
  __orca_in_prompt_command=1
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  __aha_osc7_cwd_report
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__orca_osc133_prompt_done() {
  unset __orca_in_prompt_command
  __orca_adopt_outer_debug_trap
  trap '__orca_osc133_preexec' DEBUG
}
__orca_osc133_preexec() {
  if [[ -n "\${__orca_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__orca_prompt_status_capture_command" ]]; then
    unset __orca_initial_prompt
    __orca_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}\${__orca_initial_prompt:-}\${__orca_in_prompt_dispatch:-}\${__orca_in_legacy_prompt_wrapper:-}\${__orca_in_prompt_command:-}" ]]; then
    [[ -z "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__orca_initial_prompt:-}" && "$BASH_COMMAND" == "__orca_osc133_precmd" ]]; then
      unset __orca_initial_prompt; return 0
    fi
    if [[ -n "\${__orca_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __orca_exit_code == 0 ))'|'__orca_restore_prompt_status "$__orca_exit_code"'|'eval "$__orca_prompt_part"'|'eval "$__orca_final_prompt_command"'|__orca_dispatching_user_prompt_command=*|__orca_osc133_precmd|__orca_osc133_prompt_done) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" || "$BASH_COMMAND" == "__orca_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__orca_in_legacy_prompt_wrapper:-}" || -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__orca_in_prompt_command:-}" && "$BASH_COMMAND" == "__orca_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in __orca_osc133_*|__orca_restore_prompt_status|__aha_osc7_cwd_report) return 0 ;; esac
  case "$BASH_COMMAND" in __orca_osc133_precmd|__orca_osc133_prompt_done|__aha_osc7_cwd_report) return 0 ;; esac
  __orca_run_user_debug_trap
  [[ -z "\${__orca_in_prompt_command:-}" ]] || return 0
  [[ -z "\${__orca_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__orca_prepend_prompt_command "__orca_osc133_precmd"
__orca_append_prompt_command '__orca_in_debug_capture=1; __orca_prompt_had_functrace=""; if [[ -o functrace ]]; then __orca_prompt_had_functrace=1; set +T; fi; __orca_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__orca_prompt_had_functrace" ]] || set -T; unset __orca_prompt_had_functrace __orca_in_debug_capture'
__orca_append_prompt_command "__orca_osc133_prompt_done"
__orca_had_functrace=""
[[ -o functrace ]] && __orca_had_functrace=1
set +T
__orca_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__orca_had_functrace" ]] || set -T
if [[ -n "$__orca_debug_trap_spec" && "$__orca_debug_trap_spec" != "trap -- '__orca_osc133_preexec' DEBUG" ]]; then
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
fi
unset __orca_debug_trap_spec __orca_debug_trap_command __orca_had_functrace
unset -f __orca_normalize_prompt_command_part __orca_normalize_prompt_command __orca_prepend_prompt_command __orca_append_prompt_command
unset __orca_prompt_command_normalized
__orca_initial_prompt=1
trap '__orca_osc133_preexec' DEBUG
unset __orca_initializing_wrapper
`;
}

/**
 * Generates the Zsh .zshenv wrapper that hands ZDOTDIR back to the user's real directory
 * before sourcing .zshenv, then attaches OSC 7 + OSC 133 hooks right before the first prompt.
 */
export function getZshIntegrationZshenvContent(wrapperDirMarker: string): string {
  const escapedMarker = wrapperDirMarker.replaceAll("'", "'\\''");
  return `# Ahastation interactive zsh shell integration wrapper
__aha_usable_zdotdir() {
  local dir="$1"
  [[ -n "$dir" && "$dir" != *'${escapedMarker}'* ]]
}
if __aha_usable_zdotdir "\${AHA_ORIG_ZDOTDIR:-}"; then
  builtin export ZDOTDIR="$AHA_ORIG_ZDOTDIR"
else
  builtin unset ZDOTDIR
fi
builtin unset AHA_ORIG_ZDOTDIR
builtin unfunction __aha_usable_zdotdir

__aha_osc7_cwd_report() {
  builtin emulate -L zsh
  builtin setopt no_multibyte
  if [[ $PWD != \${__aha_osc7_last_pwd-} ]]; then
    builtin typeset -g __aha_osc7_last_pwd=$PWD
    local __aha_e="" __aha_c __aha_i
    for (( __aha_i = 1; __aha_i <= $#PWD; __aha_i++ )); do
      __aha_c=$PWD[__aha_i]
      case $__aha_c in
        ([A-Za-z0-9/._~-]) __aha_e+=$__aha_c ;;
        (*) builtin printf -v __aha_c '%d' "'$__aha_c"; builtin printf -v __aha_c '%%%02X' $(( __aha_c & 255 )); __aha_e+=$__aha_c ;;
      esac
    done
    builtin typeset -g __aha_osc7_encoded=$__aha_e
  fi
  builtin printf '\\033]7;file://%s\\007' "\${__aha_osc7_encoded-}"
}

__aha_osc133_precmd() {
  local exit_code=$?
  if [[ -n "\${__aha_in_command:-}" ]]; then
    builtin printf "\\033]133;D;%s\\007" "$exit_code"
    builtin unset __aha_in_command
  fi
  __aha_osc7_cwd_report
  builtin printf "\\033]133;A\\007"
  return $exit_code
}

__aha_osc133_preexec() {
  builtin printf "\\033]133;C\\007"
  builtin typeset -g __aha_in_command=1
}

__aha_deferred_line_init() {
  builtin emulate -L zsh
  if [[ "\${CONTEXT-}" != start ]]; then
    (( \${+widgets[__aha_saved_line_init]} )) && zle __aha_saved_line_init "$@"
    return 0
  fi
  (( \${+functions[__aha_deferred_init]} )) && __aha_deferred_init
  if (( \${+widgets[zle-line-init]} )); then
    zle zle-line-init "$@"
  fi
}

__aha_deferred_init() {
  builtin emulate -L zsh
  [[ ":$ZSH_EVAL_CONTEXT:" == *:file:* ]] && return 0
  (( $+__aha_deferred_init_done )) && return 0
  builtin typeset -g __aha_deferred_init_done=1
  builtin typeset -ga precmd_functions preexec_functions
  if (( \${+widgets[__aha_saved_line_init]} )); then
    if [[ "\${widgets[zle-line-init]:-}" == user:__aha_deferred_line_init ]]; then
      zle -A __aha_saved_line_init zle-line-init
    fi
    zle -D __aha_saved_line_init
  elif [[ "\${widgets[zle-line-init]:-}" == user:__aha_deferred_line_init ]]; then
    zle -D zle-line-init
  fi
  precmd_functions=(\${precmd_functions:/__aha_deferred_init/__aha_osc133_precmd})
  (( \${precmd_functions[(Ie)__aha_osc133_precmd]} )) || precmd_functions+=(__aha_osc133_precmd)
  (( \${preexec_functions[(Ie)__aha_osc133_preexec]} )) || preexec_functions=(__aha_osc133_preexec \${preexec_functions[@]})
  __aha_osc133_precmd
  if (( \${+functions[__aha_deferred_sched_init]} )); then
    builtin unfunction __aha_deferred_sched_init
  fi
  builtin unfunction __aha_deferred_init __aha_deferred_line_init __aha_arm_deferred_init 2>/dev/null || true
}

__aha_deferred_sched_init() {
  local __aha_prompt_status=$?
  builtin emulate -L zsh
  (( \${+functions[__aha_deferred_init]} )) && __aha_deferred_init
  builtin unset __aha_deferred_sched_armed
  return $__aha_prompt_status
}

__aha_arm_deferred_init() {
  builtin emulate -L zsh
  if [[ -o interactive ]]; then
    builtin typeset -ga precmd_functions
    (( \${precmd_functions[(Ie)__aha_deferred_init]} )) || precmd_functions+=(__aha_deferred_init)
    if [[ "\${widgets[zle-line-init]:-}" != user:__aha_deferred_line_init ]]; then
      if (( \${+widgets[zle-line-init]} )); then
        zle -A zle-line-init __aha_saved_line_init
      fi
      zle -N zle-line-init __aha_deferred_line_init 2>/dev/null || true
    fi
    if (( ! $+__aha_deferred_sched_armed )) && builtin zmodload -F zsh/sched b:sched 2>/dev/null; then
      builtin sched +0 __aha_deferred_sched_init && builtin typeset -g __aha_deferred_sched_armed=1
    fi
  fi
}

__aha_arm_deferred_init
if [[ -f "\${ZDOTDIR-$HOME}/.zshenv" ]]; then
  builtin source "\${ZDOTDIR-$HOME}/.zshenv"
fi
`;
}
