// Generated from the live hrtstocks schema via the Supabase MCP
// generate_typescript_types tool. Regenerate after any migration change
// rather than hand-editing this file.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bootstrap_admin_emails: {
        Row: {
          email: string
        }
        Insert: {
          email: string
        }
        Update: {
          email?: string
        }
        Relationships: []
      }
      corporate_actions: {
        Row: {
          action_type: string
          created_at: string
          ex_date: string
          factor: number | null
          id: string
          instrument_id: string
          raw: Json | null
        }
        Insert: {
          action_type: string
          created_at?: string
          ex_date: string
          factor?: number | null
          id?: string
          instrument_id: string
          raw?: Json | null
        }
        Update: {
          action_type?: string
          created_at?: string
          ex_date?: string
          factor?: number | null
          id?: string
          instrument_id?: string
          raw?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_actions_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      coverage_reconciliation: {
        Row: {
          manual_review: number
          reconciled: boolean
          rejected: number
          run_id: string
          tier_a: number
          tier_b: number
          unavailable: number
          unique_stock_count: number
          watch: number
        }
        Insert: {
          manual_review: number
          reconciled: boolean
          rejected: number
          run_id: string
          tier_a: number
          tier_b: number
          unavailable: number
          unique_stock_count: number
          watch: number
        }
        Update: {
          manual_review?: number
          reconciled?: boolean
          rejected?: number
          run_id?: string
          tier_a?: number
          tier_b?: number
          unavailable?: number
          unique_stock_count?: number
          watch?: number
        }
        Relationships: [
          {
            foreignKeyName: "coverage_reconciliation_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "screening_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      data_quality_results: {
        Row: {
          check_name: string
          created_at: string
          details: Json | null
          id: number
          instrument_id: string | null
          result: Database["public"]["Enums"]["data_quality_state"]
          run_id: string | null
        }
        Insert: {
          check_name: string
          created_at?: string
          details?: Json | null
          id?: never
          instrument_id?: string | null
          result: Database["public"]["Enums"]["data_quality_state"]
          run_id?: string | null
        }
        Update: {
          check_name?: string
          created_at?: string
          details?: Json | null
          id?: never
          instrument_id?: string | null
          result?: Database["public"]["Enums"]["data_quality_state"]
          run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_quality_results_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      derivative_contracts: {
        Row: {
          contract_type: string
          created_at: string
          expiry: string | null
          id: string
          instrument_id: string | null
          lot_size: number | null
          raw: Json | null
          strike: number | null
        }
        Insert: {
          contract_type: string
          created_at?: string
          expiry?: string | null
          id?: string
          instrument_id?: string | null
          lot_size?: number | null
          raw?: Json | null
          strike?: number | null
        }
        Update: {
          contract_type?: string
          created_at?: string
          expiry?: string | null
          id?: string
          instrument_id?: string | null
          lot_size?: number | null
          raw?: Json | null
          strike?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "derivative_contracts_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      derivative_snapshots: {
        Row: {
          ask: number | null
          bid: number | null
          contract_id: string | null
          id: number
          iv: number | null
          last: number | null
          oi: number | null
          oi_change: number | null
          raw: Json | null
          ts: string
          volume: number | null
        }
        Insert: {
          ask?: number | null
          bid?: number | null
          contract_id?: string | null
          id?: never
          iv?: number | null
          last?: number | null
          oi?: number | null
          oi_change?: number | null
          raw?: Json | null
          ts: string
          volume?: number | null
        }
        Update: {
          ask?: number | null
          bid?: number | null
          contract_id?: string | null
          id?: never
          iv?: number | null
          last?: number | null
          oi?: number | null
          oi_change?: number | null
          raw?: Json | null
          ts?: string
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "derivative_snapshots_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "derivative_contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      index_memberships: {
        Row: {
          created_at: string
          effective_date: string
          id: string
          index_id: string
          instrument_id: string
          is_current: boolean
        }
        Insert: {
          created_at?: string
          effective_date: string
          id?: string
          index_id: string
          instrument_id: string
          is_current?: boolean
        }
        Update: {
          created_at?: string
          effective_date?: string
          id?: string
          index_id?: string
          instrument_id?: string
          is_current?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "index_memberships_index_id_fkey"
            columns: ["index_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "index_memberships_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      instrument_run_results: {
        Row: {
          created_at: string
          data_quality: Database["public"]["Enums"]["data_quality_state"] | null
          direction: string | null
          failed_gates: string[]
          id: number
          instrument_id: string
          is_index: boolean
          run_id: string
          score: number | null
          terminal_state: Database["public"]["Enums"]["terminal_state"]
          tier: Database["public"]["Enums"]["run_tier"] | null
        }
        Insert: {
          created_at?: string
          data_quality?:
            | Database["public"]["Enums"]["data_quality_state"]
            | null
          direction?: string | null
          failed_gates?: string[]
          id?: never
          instrument_id: string
          is_index?: boolean
          run_id: string
          score?: number | null
          terminal_state: Database["public"]["Enums"]["terminal_state"]
          tier?: Database["public"]["Enums"]["run_tier"] | null
        }
        Update: {
          created_at?: string
          data_quality?:
            | Database["public"]["Enums"]["data_quality_state"]
            | null
          direction?: string | null
          failed_gates?: string[]
          id?: never
          instrument_id?: string
          is_index?: boolean
          run_id?: string
          score?: number | null
          terminal_state?: Database["public"]["Enums"]["terminal_state"]
          tier?: Database["public"]["Enums"]["run_tier"] | null
        }
        Relationships: [
          {
            foreignKeyName: "instrument_run_results_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instrument_run_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "screening_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      instruments: {
        Row: {
          created_at: string
          exchange: string
          id: string
          is_index: boolean
          isin: string | null
          name: string | null
          symbol: string
        }
        Insert: {
          created_at?: string
          exchange?: string
          id: string
          is_index?: boolean
          isin?: string | null
          name?: string | null
          symbol: string
        }
        Update: {
          created_at?: string
          exchange?: string
          id?: string
          is_index?: boolean
          isin?: string | null
          name?: string | null
          symbol?: string
        }
        Relationships: []
      }
      market_bars_adjusted: {
        Row: {
          adjustment_version: string
          close: number | null
          created_at: string
          high: number | null
          id: number
          instrument_id: string
          low: number | null
          open: number | null
          session_date: string
          ts: string
          volume: number | null
        }
        Insert: {
          adjustment_version?: string
          close?: number | null
          created_at?: string
          high?: number | null
          id?: never
          instrument_id: string
          low?: number | null
          open?: number | null
          session_date: string
          ts: string
          volume?: number | null
        }
        Update: {
          adjustment_version?: string
          close?: number | null
          created_at?: string
          high?: number | null
          id?: never
          instrument_id?: string
          low?: number | null
          open?: number | null
          session_date?: string
          ts?: string
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_bars_adjusted_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      market_bars_raw: {
        Row: {
          close: number | null
          freshness: Database["public"]["Enums"]["freshness_label"]
          high: number | null
          id: number
          instrument_id: string
          low: number | null
          open: number | null
          provider: string
          retrieved_at: string
          session_date: string
          ts: string
          volume: number | null
        }
        Insert: {
          close?: number | null
          freshness: Database["public"]["Enums"]["freshness_label"]
          high?: number | null
          id?: never
          instrument_id: string
          low?: number | null
          open?: number | null
          provider: string
          retrieved_at?: string
          session_date: string
          ts: string
          volume?: number | null
        }
        Update: {
          close?: number | null
          freshness?: Database["public"]["Enums"]["freshness_label"]
          high?: number | null
          id?: never
          instrument_id?: string
          low?: number | null
          open?: number | null
          provider?: string
          retrieved_at?: string
          session_date?: string
          ts?: string
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_bars_raw_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
        ]
      }
      parameter_versions: {
        Row: {
          created_at: string
          id: string
          status: string
          values: Json
          version: string
        }
        Insert: {
          created_at?: string
          id?: string
          status: string
          values: Json
          version: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: string
          values?: Json
          version?: string
        }
        Relationships: []
      }
      pipeline_audit_log: {
        Row: {
          created_at: string
          id: number
          message: string | null
          run_id: string | null
          stage: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: never
          message?: string | null
          run_id?: string | null
          stage: string
          status: string
        }
        Update: {
          created_at?: string
          id?: never
          message?: string | null
          run_id?: string | null
          stage?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_audit_log_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "screening_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
      rankings: {
        Row: {
          component_scores: Json | null
          direction: string | null
          id: number
          instrument_id: string
          rank_within_tier: number | null
          run_id: string
          tier: Database["public"]["Enums"]["run_tier"]
          total_score: number | null
        }
        Insert: {
          component_scores?: Json | null
          direction?: string | null
          id?: never
          instrument_id: string
          rank_within_tier?: number | null
          run_id: string
          tier: Database["public"]["Enums"]["run_tier"]
          total_score?: number | null
        }
        Update: {
          component_scores?: Json | null
          direction?: string | null
          id?: never
          instrument_id?: string
          rank_within_tier?: number | null
          run_id?: string
          tier?: Database["public"]["Enums"]["run_tier"]
          total_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "rankings_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rankings_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "screening_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      rule_definitions: {
        Row: {
          created_at: string
          direction: string | null
          expression: string
          false_result: Database["public"]["Enums"]["rule_result"]
          framework: string
          hard_gate: boolean
          id: string
          inputs: string[]
          missing_result: Database["public"]["Enums"]["rule_result"]
          name: string
          parameters: string[]
          raw: Json
          rule_id: string
          scope: string | null
          source_refs: Json | null
          source_status: Database["public"]["Enums"]["rule_source_status"]
          strategy_version_id: string
          timeframe: string | null
          true_result: Database["public"]["Enums"]["rule_result"]
        }
        Insert: {
          created_at?: string
          direction?: string | null
          expression: string
          false_result: Database["public"]["Enums"]["rule_result"]
          framework: string
          hard_gate?: boolean
          id?: string
          inputs?: string[]
          missing_result: Database["public"]["Enums"]["rule_result"]
          name: string
          parameters?: string[]
          raw: Json
          rule_id: string
          scope?: string | null
          source_refs?: Json | null
          source_status: Database["public"]["Enums"]["rule_source_status"]
          strategy_version_id: string
          timeframe?: string | null
          true_result: Database["public"]["Enums"]["rule_result"]
        }
        Update: {
          created_at?: string
          direction?: string | null
          expression?: string
          false_result?: Database["public"]["Enums"]["rule_result"]
          framework?: string
          hard_gate?: boolean
          id?: string
          inputs?: string[]
          missing_result?: Database["public"]["Enums"]["rule_result"]
          name?: string
          parameters?: string[]
          raw?: Json
          rule_id?: string
          scope?: string | null
          source_refs?: Json | null
          source_status?: Database["public"]["Enums"]["rule_source_status"]
          strategy_version_id?: string
          timeframe?: string | null
          true_result?: Database["public"]["Enums"]["rule_result"]
        }
        Relationships: [
          {
            foreignKeyName: "rule_definitions_strategy_version_id_fkey"
            columns: ["strategy_version_id"]
            isOneToOne: false
            referencedRelation: "strategy_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      rule_traces: {
        Row: {
          confidence: number | null
          data_source: string | null
          evaluation_timestamp: string
          explanation: string | null
          id: number
          instrument_id: string
          observed_values: Json | null
          parameter_version: string | null
          result: Database["public"]["Enums"]["rule_result"]
          rule_id: string
          rule_version: string | null
          run_id: string
          source_document: string | null
          source_locator: string | null
          thresholds: Json | null
        }
        Insert: {
          confidence?: number | null
          data_source?: string | null
          evaluation_timestamp?: string
          explanation?: string | null
          id?: never
          instrument_id: string
          observed_values?: Json | null
          parameter_version?: string | null
          result: Database["public"]["Enums"]["rule_result"]
          rule_id: string
          rule_version?: string | null
          run_id: string
          source_document?: string | null
          source_locator?: string | null
          thresholds?: Json | null
        }
        Update: {
          confidence?: number | null
          data_source?: string | null
          evaluation_timestamp?: string
          explanation?: string | null
          id?: never
          instrument_id?: string
          observed_values?: Json | null
          parameter_version?: string | null
          result?: Database["public"]["Enums"]["rule_result"]
          rule_id?: string
          rule_version?: string | null
          run_id?: string
          source_document?: string | null
          source_locator?: string | null
          thresholds?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "rule_traces_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rule_traces_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "screening_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      screening_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          mode: string
          parameter_version_id: string | null
          providers: Json | null
          run_date: string
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          strategy_version_ids: string[]
          trigger_type: Database["public"]["Enums"]["run_trigger_type"]
          triggered_by: string | null
          universe_version: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          mode?: string
          parameter_version_id?: string | null
          providers?: Json | null
          run_date: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          strategy_version_ids?: string[]
          trigger_type: Database["public"]["Enums"]["run_trigger_type"]
          triggered_by?: string | null
          universe_version: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          mode?: string
          parameter_version_id?: string | null
          providers?: Json | null
          run_date?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          strategy_version_ids?: string[]
          trigger_type?: Database["public"]["Enums"]["run_trigger_type"]
          triggered_by?: string | null
          universe_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "screening_runs_parameter_version_id_fkey"
            columns: ["parameter_version_id"]
            isOneToOne: false
            referencedRelation: "parameter_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_versions: {
        Row: {
          created_at: string
          framework: string
          id: string
          is_active: boolean
          parameter_version: string | null
          raw_yaml: Json
          rule_version: string
          status: string
          strategy_id: string
        }
        Insert: {
          created_at?: string
          framework: string
          id?: string
          is_active?: boolean
          parameter_version?: string | null
          raw_yaml: Json
          rule_version: string
          status: string
          strategy_id: string
        }
        Update: {
          created_at?: string
          framework?: string
          id?: string
          is_active?: boolean
          parameter_version?: string | null
          raw_yaml?: Json
          rule_version?: string
          status?: string
          strategy_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_role_name: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
    }
    Enums: {
      data_quality_state: "PASS" | "PARTIAL" | "STALE" | "INVALID" | "NO_DATA"
      freshness_label: "LIVE" | "DELAYED" | "INTRADAY" | "EOD"
      rule_result:
        | "PASS"
        | "FAIL"
        | "WATCH"
        | "MANUAL_REVIEW"
        | "NO_DATA"
        | "NOT_APPLICABLE"
        | "CONFLICT"
      rule_source_status:
        | "DOCUMENTED"
        | "PROJECT_DEFAULT"
        | "INFERRED"
        | "CONFLICT"
        | "UNRESOLVED"
      run_status: "queued" | "running" | "completed" | "failed" | "partial"
      run_tier:
        | "tier_a"
        | "tier_b"
        | "watch"
        | "manual_review"
        | "rejected"
        | "unavailable"
      run_trigger_type: "manual" | "scheduled"
      terminal_state: "PASS" | "WATCH" | "MANUAL_REVIEW" | "FAIL" | "NO_DATA"
      user_role: "viewer" | "researcher" | "strategy_admin" | "system_admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      data_quality_state: ["PASS", "PARTIAL", "STALE", "INVALID", "NO_DATA"],
      freshness_label: ["LIVE", "DELAYED", "INTRADAY", "EOD"],
      rule_result: [
        "PASS",
        "FAIL",
        "WATCH",
        "MANUAL_REVIEW",
        "NO_DATA",
        "NOT_APPLICABLE",
        "CONFLICT",
      ],
      rule_source_status: [
        "DOCUMENTED",
        "PROJECT_DEFAULT",
        "INFERRED",
        "CONFLICT",
        "UNRESOLVED",
      ],
      run_status: ["queued", "running", "completed", "failed", "partial"],
      run_tier: [
        "tier_a",
        "tier_b",
        "watch",
        "manual_review",
        "rejected",
        "unavailable",
      ],
      run_trigger_type: ["manual", "scheduled"],
      terminal_state: ["PASS", "WATCH", "MANUAL_REVIEW", "FAIL", "NO_DATA"],
      user_role: ["viewer", "researcher", "strategy_admin", "system_admin"],
    },
  },
} as const
