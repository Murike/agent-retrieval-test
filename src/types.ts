export type FieldRole =
  | "identifier"
  | "label"
  | "location"
  | "amount"
  | "price"
  | "quantity"
  | "unit"
  | "date"
  | "party"
  | "rank"
  | "extra";

export interface ColumnMapping {
  originalHeader: string;
  mappedName: string;
  tier: "synonym" | "llm" | "unmapped";
  confidence: number;
  role: FieldRole;
  semanticLabel: string;
}

export interface ColumnMappingResult {
  mappings: ColumnMapping[];
  unmapped: string[];
}

export interface OutlierFlag {
  party: string;
  amount: number;
  deviation: "high" | "low";
  methods: Array<"iqr" | "mad" | "ratio_to_min">;
  detail: string;
}

export interface CsvChunk {
  id: string;
  summary: string;
  rows: Record<string, string>[];
  columnMappings: ColumnMapping[];
  outliers: OutlierFlag[];
  qualityScore: number;
  groundedness: "direct";
  confidence: number;
  caveats: string[];
}

export interface PdfChunk {
  id: string;
  pageNum: number;
  text: string;
  method: "text_layer" | "ocr";
  qualityScore: number;
  groundedness: "direct";
  confidence: number;
  warnings: string[];
}

export interface StoredChunk {
  id: string;
  source: "csv" | "pdf";
  document: string;
  metadata: CsvChunk | PdfChunk;
}

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
}

export interface AgentAnswer {
  answer: string;
  confidence: "high" | "medium" | "low";
  grounded_in_context: boolean;
  data_caveats: string[];
  sources: Array<{
    type: "csv_row" | "pdf_chunk";
    reference: string;
  }>;
}

export interface IngestedFile {
  path: string;
  type: "csv" | "pdf";
  chunkCount: number;
  ingestedAt: Date;
}
