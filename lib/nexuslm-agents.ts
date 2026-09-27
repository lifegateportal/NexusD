import { z } from "zod";

export const NexusLMAgentSchema = z.enum(["nexusR1", "NexusChat"]);

export type NexusLMAgent = z.infer<typeof NexusLMAgentSchema>;

export const NEXUSLM_AGENTS: Record<NexusLMAgent, { label: string; description: string }> = {
  nexusR1: {
    label: "nexusR1",
    description: "DeepSeek Reasoner for structure, critique, and difficult decisions",
  },
  NexusChat: {
    label: "NexusChat",
    description: "DeepSeek Chat for fast conversation and drafting",
  },
};
