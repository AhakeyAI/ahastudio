// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__aha_normalize_prompt_command_part() {
  local __aha_value="$1" __aha_output_name="$2" __aha_character __aha_chunk
  local __aha_value_length=\${#1} __aha_suffix_length=0 __aha_backslash_length=0
  local __aha_output_length __aha_scan_start
  while (( __aha_value_length - __aha_suffix_length >= 1024 )); do
    __aha_scan_start=$(( __aha_value_length - __aha_suffix_length - 1024 ))
    __aha_chunk="\${__aha_value:__aha_scan_start:1024}"
    case "$__aha_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __aha_suffix_length=$(( __aha_suffix_length + 1024 )) ;;
    esac
  done
  while (( __aha_suffix_length < __aha_value_length )); do
    __aha_character="\${__aha_value: -__aha_suffix_length - 1:1}"
    case "$__aha_character" in
      ' '|$'\\t'|$'\\n'|';') __aha_suffix_length=$(( __aha_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __aha_output_length=$(( \${#__aha_value} - __aha_suffix_length ))
  while (( __aha_output_length - __aha_backslash_length >= 1024 )); do
    __aha_scan_start=$(( __aha_output_length - __aha_backslash_length - 1024 ))
    __aha_chunk="\${__aha_value:__aha_scan_start:1024}"
    case "$__aha_chunk" in
      *[!\\\\]*) break ;;
      *) __aha_backslash_length=$(( __aha_backslash_length + 1024 )) ;;
    esac
  done
  while (( __aha_backslash_length < __aha_output_length )); do
    __aha_character="\${__aha_value:__aha_output_length - __aha_backslash_length - 1:1}"
    [[ "$__aha_character" == '\\' ]] || break
    __aha_backslash_length=$(( __aha_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __aha_suffix_length > 0 && __aha_backslash_length % 2 == 1 )); then
    __aha_suffix_length=$(( __aha_suffix_length - 1 ))
    __aha_backslash_length=0
  fi
  __aha_output_length=$(( \${#__aha_value} - __aha_suffix_length ))
  __aha_value="\${__aha_value:0:__aha_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __aha_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __aha_backslash_length % 2 == 1 )); then
    __aha_value="$__aha_value\\\\"
  fi
  printf -v "$__aha_output_name" '%s' "$__aha_value"
}
__aha_restore_prompt_status() {
  return "$1"
}
__aha_update_user_debug_trap() {
  local __aha_debug_trap_spec="$1" __aha_unchanged_debug_trap_spec="$2"
  local __aha_debug_trap_command
  [[ "$__aha_debug_trap_spec" != "$__aha_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__aha_debug_trap_spec" != "trap -- '__aha_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__aha_debug_trap_spec" ]]; then
    __aha_user_debug_trap=""
    unset __aha_chained_debug_trap
    return 0
  fi
  __aha_debug_trap_command="\${__aha_debug_trap_spec#trap -- }"
  __aha_debug_trap_command="\${__aha_debug_trap_command% DEBUG}"
  eval "__aha_user_debug_trap=$__aha_debug_trap_command"
  unset __aha_chained_debug_trap
}
__aha_run_user_debug_trap() {
  if [[ -n "\${__aha_user_debug_trap:-}" ]]; then
    eval "$__aha_user_debug_trap" || true
  fi
}
__aha_adopt_outer_debug_trap() {
  local __aha_debug_trap_spec="\${__aha_outer_debug_trap_spec:-}"
  unset __aha_outer_debug_trap_spec
  __aha_update_user_debug_trap "$__aha_debug_trap_spec" "trap -- '__aha_osc133_preexec' DEBUG"
}
__aha_run_prompt_command_array() {
  local __aha_exit_code="\${__aha_prompt_status:-$?}" __aha_prompt_part __aha_prompt_index __aha_user_count
  local __aha_suffix_part
  local __aha_final_prompt_command
  local __aha_in_prompt_dispatch=1 __aha_dispatching_user_prompt_command=""
  unset __aha_prompt_status
  __aha_adopt_outer_debug_trap
  trap '__aha_osc133_preexec' DEBUG
  for __aha_prompt_part in "\${__aha_prompt_command_prefix[@]+"\${__aha_prompt_command_prefix[@]}"}"; do
    if (( __aha_exit_code == 0 )); then
      eval "$__aha_prompt_part"
    else
      __aha_restore_prompt_status "$__aha_exit_code" || eval "$__aha_prompt_part"
    fi
  done
  __aha_user_count=0
  for __aha_prompt_part in "\${__aha_prompt_command_array[@]+"\${__aha_prompt_command_array[@]}"}"; do
    __aha_user_count=$(( __aha_user_count + 1 ))
  done
  for (( __aha_prompt_index = 0; __aha_prompt_index + 1 < __aha_user_count; __aha_prompt_index++ )); do
    __aha_prompt_part="\${__aha_prompt_command_array[__aha_prompt_index]}"
    __aha_dispatching_user_prompt_command=1
    if (( __aha_exit_code == 0 )); then
      eval "$__aha_prompt_part"
    else
      __aha_restore_prompt_status "$__aha_exit_code" || eval "$__aha_prompt_part"
    fi
    __aha_dispatching_user_prompt_command=""
  done
  if (( __aha_user_count > 0 )); then
    __aha_prompt_part="\${__aha_prompt_command_array[__aha_user_count - 1]}"
    # Why: keep the final user hook and Aha suffixes in one status-preserving eval.
    __aha_final_prompt_command='eval "$__aha_prompt_part"'
    for __aha_suffix_part in "\${__aha_prompt_command_suffix[@]+"\${__aha_prompt_command_suffix[@]}"}"; do
      __aha_final_prompt_command+=$'\\n'"$__aha_suffix_part"
    done
    __aha_dispatching_user_prompt_command=1
    if (( __aha_exit_code == 0 )); then
      eval "$__aha_final_prompt_command"
    else
      __aha_restore_prompt_status "$__aha_exit_code" || eval "$__aha_final_prompt_command"
    fi
    __aha_dispatching_user_prompt_command=""
  else
    for __aha_prompt_part in "\${__aha_prompt_command_suffix[@]+"\${__aha_prompt_command_suffix[@]}"}"; do
      if (( __aha_exit_code == 0 )); then
        eval "$__aha_prompt_part"
      else
        __aha_restore_prompt_status "$__aha_exit_code" || eval "$__aha_prompt_part"
      fi
    done
  fi
  return "$__aha_exit_code"
}
__aha_finish_legacy_prompt_dispatch() {
  local __aha_suffix_part
  if [[ -n "\${__aha_in_prompt_command:-}" ]]; then
    for __aha_suffix_part in "\${__aha_prompt_command_suffix[@]+"\${__aha_prompt_command_suffix[@]}"}"; do
      eval "$__aha_suffix_part"
    done
  fi
}
__aha_normalize_prompt_command() {
  [[ -z "\${__aha_prompt_command_normalized:-}" ]] || return 0
  local __aha_prompt_part
  local -a __aha_normalized=()
  for __aha_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __aha_normalize_prompt_command_part "$__aha_prompt_part" __aha_prompt_part
    [[ -n "$__aha_prompt_part" ]] && __aha_normalized+=("$__aha_prompt_part")
  done
  __aha_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__aha_normalized[@]+"\${__aha_normalized[@]}"}")
  else
    __aha_prompt_command_array=("\${__aha_normalized[@]+"\${__aha_normalized[@]}"}")
    __aha_prompt_command_prefix=()
    __aha_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __aha_prompt_status_variable="__aha_prompt_status_$$"
    __aha_prompt_status_capture_command="$__aha_prompt_status_variable=\\$?"
    __aha_prompt_status_value="\\\${$__aha_prompt_status_variable}"
    # Why: a changed DEBUG trap misses the capture command, and bash <= 4.3 reverts traps set in functions.
    PROMPT_COMMAND="$__aha_prompt_status_capture_command; __aha_in_legacy_prompt_wrapper=1; __aha_prompt_status=$__aha_prompt_status_value"'; __aha_prompt_had_functrace=""; if [[ -o functrace ]]; then __aha_prompt_had_functrace=1; set +T; fi; __aha_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__aha_prompt_had_functrace" ]] || set -T; unset __aha_prompt_had_functrace; __aha_run_prompt_command_array; __aha_finish_legacy_prompt_dispatch; trap __aha_osc133_preexec DEBUG; unset __aha_in_legacy_prompt_wrapper'
  fi
}
__aha_prepend_prompt_command() {
  local command="$1"
  __aha_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __aha_prompt_command_prefix=("$command" "\${__aha_prompt_command_prefix[@]+"\${__aha_prompt_command_prefix[@]}"}")
  fi
}
__aha_append_prompt_command() {
  local command="$1"
  __aha_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __aha_prompt_command_suffix+=("$command")
  fi
}`
