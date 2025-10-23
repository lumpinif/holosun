export interface DealerInfo {
  id?: number;
  company_name?: string;
  first_name?: string;
  last_name?: string;
  contact?: string;
  tel?: string;
  phone?: string;
  email?: string;
  website?: string;
  contact_addr?: string;
  zip?: string;
  lat?: string;
  lng?: string;
  type?: string;
  category?: string;
  reseller_id?: string;
  ein?: string;
  employees?: string;
  mon_sales?: string;
  create_time?: number;
  [key: string]: any; // Allow for additional fields from API
}

export interface HolosunApiResponse {
  code?: number;
  msg?: string;
  data?: {
    total?: string;
    list?: DealerInfo[];
  };
  list?: DealerInfo[];
  [key: string]: any; // Allow for flexible response structure
}
