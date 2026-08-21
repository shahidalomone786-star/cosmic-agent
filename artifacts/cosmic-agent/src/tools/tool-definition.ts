export type ToolRisk = 'read' | 'write' | 'destructive';

export interface ToolDefinition<Input = unknown, Output = unknown> {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  requiresApproval: boolean;
  execute(input: Input): Promise<Output>;
}