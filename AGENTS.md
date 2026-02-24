Extensions for the pi coding agent

This project uses the Artemis issue tracker.

## Building, testing and running ##

ALWAYS use `nix-build` for testing, since we do not have any JS interpreters, etc.

`nix-build -A extensions.foo` will build and test the contents of `extensions/foo/`

**Coding style**: Prefer simplicity, robustness and directness.

## Testing ##

The most important tests are functional/integration/end-to-end tests:
- Use real dependencies to perform real tasks (in the safety of the Nix sandbox)
- Mock the LLM itself, since they're not available in the sandbox

Those tests are slow, so only use them to test (a) that we're plugging things
together correctly, and (b) our assumptions about the interfaces and behaviour
of any external systems we're using.

Our own logic should ideally use pure functions. Complex computations should
have fast unit tests to cover various cases.
