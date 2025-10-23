import type { DealerInfo, HolosunApiResponse } from './types';

const HOLOSUN_API_URL = 'https://holosun.com/index/dealer/search.html';

// Cache for geocoded coordinates to avoid repeated API calls
const geocodeCache = new Map<number, { lat: number; lng: number }>();

/**
 * Delay utility function for rate limiting
 */
export const delay = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/** @NOTE: OPTIONALY HERE TO USE
 * Delay for a random duration between 10–50 ms
 */
export const randomDelay = async (): Promise<void> => {
  const ms = Math.floor(Math.random() * (50 - 10 + 1)) + 10; // random 10–50
  await delay(ms);
};

/**
 * Geocode a zip code to latitude and longitude coordinates
 * Uses the free Zippopotam.us API (no rate limits, no API key required)
 */
async function geocodeZipCode(zipCode: number): Promise<{ lat: number; lng: number } | null> {
  // Check cache first
  if (geocodeCache.has(zipCode)) {
    return geocodeCache.get(zipCode)!;
  }

  try {
    // Use Zippopotam.us API (free, reliable, no API key required)
    const response = await fetch(
      `https://api.zippopotam.us/us/${zipCode}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    if (!response.ok) {
      console.error(`Geocoding failed for zip ${zipCode}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.places && data.places.length > 0) {
      const coords = {
        lat: parseFloat(data.places[0].latitude),
        lng: parseFloat(data.places[0].longitude)
      };

      // Cache the result
      geocodeCache.set(zipCode, coords);

      // Small delay to be respectful (but no strict rate limit)
      await delay(50);

      return coords;
    }

    console.warn(`No geocoding results found for zip ${zipCode}`);
    return null;
  } catch (error) {
    console.error(`Error geocoding zip ${zipCode}:`, error);
    return null;
  }
}

/**
 * Fetch dealers for a specific zip code from Holosun API
 */
export async function fetchDealersForZip(zipCode: number, debug = false): Promise<DealerInfo[]> {
  try {
    // Geocode the zip code to get actual coordinates
    const coords = await geocodeZipCode(zipCode);

    if (!coords) {
      console.error(`Failed to geocode zip ${zipCode}, skipping...`);
      return [];
    }

    if (debug) {
      console.log(`🌍 Geocoded zip ${zipCode} to lat=${coords.lat}, lng=${coords.lng}`);
    }

    const formData = new URLSearchParams({
      keywords: zipCode.toString(),
      distance: '100',
      lat: coords.lat.toString(),
      lng: coords.lng.toString(),
      cate: 'both'
    });

    if (debug) {
      console.log('\n🔍 DEBUG - Request details:');
      console.log('URL:', HOLOSUN_API_URL);
      console.log('Body:', formData.toString());
    }

    const response = await fetch(HOLOSUN_API_URL, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'en,zh-CN;q=0.9,zh;q=0.8,pt;q=0.7',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://holosun.com',
        'referer': 'https://holosun.com/where-to-buy.html?c=both',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      },
      body: formData.toString(),
      // Disable SSL certificate verification for this request
      tls: {
        rejectUnauthorized: false
      }
    } as any);

    if (debug) {
      console.log('Response status:', response.status, response.statusText);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    }

    if (!response.ok) {
      console.error(`Failed to fetch data for zip ${zipCode}: ${response.status} ${response.statusText}`);
      if (debug) {
        const text = await response.text();
        console.log('Response body:', text);
      }
      return [];
    }

    const text = await response.text();

    if (debug) {
      console.log('\n📄 Raw response body:');
      console.log(text);
      console.log('\n');
    }

    let data: HolosunApiResponse;
    try {
      data = JSON.parse(text);

      if (debug) {
        console.log('📦 Parsed JSON:');
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (parseError) {
      console.error(`Failed to parse JSON for zip ${zipCode}:`, parseError);
      if (debug) {
        console.log('Text that failed to parse:', text);
      }
      return [];
    }

    // Handle different possible response structures
    // API returns: { code: 1, msg: "Success", data: { total: "2514", list: [...] } }
    let dealers: any[] = [];

    if (data.data && typeof data.data === 'object' && Array.isArray(data.data.list)) {
      dealers = data.data.list;
    } else if (Array.isArray(data.list)) {
      dealers = data.list;
    } else if (Array.isArray(data.data)) {
      dealers = data.data;
    }

    if (debug) {
      console.log('\n✅ Dealers found:', dealers.length);
      console.log('Total in response:', data.data?.total || 'N/A');
      if (dealers.length > 0) {
        console.log('First dealer sample:', JSON.stringify(dealers[0], null, 2));
      }
    }

    return dealers;
  } catch (error) {
    console.error(`Error fetching data for zip ${zipCode}:`, error);
    return [];
  }
}

/**
 * Deduplicate dealers based on name and address
 */
export function deduplicateDealers(dealers: DealerInfo[]): DealerInfo[] {
  const uniqueMap = new Map<string, DealerInfo>();

  for (const dealer of dealers) {
    // Create a unique key using name and address (normalized)
    const key = `${(dealer.name || '').toLowerCase().trim()}-${(dealer.address || '').toLowerCase().trim()}`;

    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, dealer);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Convert dealers array to CSV format with specific fields only
 */
export function convertToCSV(dealers: DealerInfo[]): string {
  if (dealers.length === 0) {
    return '';
  }

  // Only include these specific fields in the CSV
  const headers = ['id', 'first_name', 'last_name', 'phone', 'tel', 'email', 'company_name', 'contact_addr'];

  // Create CSV header row
  const csvRows: string[] = [];
  csvRows.push(headers.map(escapeCSVValue).join(','));

  // Create CSV data rows
  for (const dealer of dealers) {
    const row = headers.map(header => {
      const value = dealer[header];
      return escapeCSVValue(value !== undefined && value !== null ? String(value) : '');
    });
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

/**
 * Escape CSV values to handle commas, quotes, and newlines
 */
function escapeCSVValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Write CSV content to file
 */
export async function writeCSVFile(filename: string, content: string): Promise<void> {
  try {
    await Bun.write(filename, content);
    console.log(`CSV file written successfully: ${filename}`);
  } catch (error) {
    console.error(`Error writing CSV file:`, error);
    throw error;
  }
}

/**
 * Append CSV rows to file (for incremental writing)
 */
export async function appendToCSV(filename: string, dealers: DealerInfo[]): Promise<void> {
  if (dealers.length === 0) return;

  const headers = ['id', 'first_name', 'last_name', 'phone', 'tel', 'email', 'company_name', 'contact_addr'];

  const csvRows: string[] = [];
  for (const dealer of dealers) {
    const row = headers.map(header => {
      const value = dealer[header];
      return escapeCSVValue(value !== undefined && value !== null ? String(value) : '');
    });
    csvRows.push(row.join(','));
  }

  try {
    const file = Bun.file(filename);
    const exists = await file.exists();

    if (exists) {
      // Append to existing file
      const existingContent = await file.text();
      await Bun.write(filename, existingContent + '\n' + csvRows.join('\n'));
    } else {
      // Create new file with headers
      const headersRow = headers.map(escapeCSVValue).join(',');
      await Bun.write(filename, headersRow + '\n' + csvRows.join('\n'));
    }
  } catch (error) {
    console.error(`Error appending to CSV file:`, error);
    throw error;
  }
}
