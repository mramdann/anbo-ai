# anbo-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _anbo_user_zdotdir="${ANBO_USER_ZDOTDIR:-$HOME}"
  [ -f "$_anbo_user_zdotdir/.zprofile" ] && source "$_anbo_user_zdotdir/.zprofile"
  unset _anbo_user_zdotdir
}
:
