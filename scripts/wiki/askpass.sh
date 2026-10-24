#!/bin/sh
# Git consumes stdout privately. Never enable shell tracing in this helper or its caller.
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) test -n "$WIKI_TOKEN" && printf '%s\n' "$WIKI_TOKEN" ;;
  *) exit 1 ;;
esac
