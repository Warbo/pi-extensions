## ollama-react ##

This Pi extension attempts to convert LLM messages from the ReAct protocol
([example](https://reference.langchain.com/python/langchain-classic/agents/output_parsers/react_single_input/ReActSingleInputOutputParser)) to the tool_call JSON expected by Pi.

This can be useful for using small language models (e.g. local Ollama models)
which have been specifically trained/fine-tuned to output ReAct messages.
