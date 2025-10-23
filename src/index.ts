import { Hono } from 'hono'
import { CA_ZIP_CODES } from '../ca_zip_codes'
import { fetchDealersForZip, delay, appendToCSV, deduplicateDealers } from './scraper'
import type { DealerInfo } from './types'

const app = new Hono()

// Job status tracking
let jobStatus = {
  isRunning: false,
  startTime: 0,
  processedCount: 0,
  totalCount: CA_ZIP_CODES.length,
  dealersFound: 0,
  errorCount: 0,
  currentZip: 0
}

app.get('/', (c) => {
  return c.text('Holosun Dealer Scraper API\n\nEndpoints:\n- GET /start?skip=N - Start CA scraping job (optional skip: process every Nth zip code, default: 1)\n- GET /status - Check scraping job status\n- GET /test - Test with first 10 zip codes\n- GET /debug/:zipcode - Debug single zip code (e.g., /debug/90002)\n\n💡 TIP: Use ?skip=5 or ?skip=10 to reduce duplicates and save time!\n   Since each zip searches 100-mile radius, adjacent zips have heavy overlap.')
})

app.get('/debug/:zipcode', async (c) => {
  const zipCode = parseInt(c.req.param('zipcode'));

  if (isNaN(zipCode)) {
    return c.json({ error: 'Invalid zip code' }, 400);
  }

  console.log(`\n🔍 DEBUG MODE - Testing zip code: ${zipCode}\n`);

  const dealers = await fetchDealersForZip(zipCode, true); // Enable debug mode

  return c.json({
    zipCode,
    dealersFound: dealers.length,
    dealers
  });
})

app.get('/status', (c) => {
  if (!jobStatus.isRunning && jobStatus.processedCount === 0) {
    return c.json({
      status: 'idle',
      message: 'No job running. Visit /start to start.'
    })
  }

  const progress = jobStatus.totalCount > 0
    ? ((jobStatus.processedCount / jobStatus.totalCount) * 100).toFixed(1)
    : '0'

  const elapsedSeconds = jobStatus.startTime > 0
    ? Math.floor((Date.now() - jobStatus.startTime) / 1000)
    : 0

  return c.json({
    status: jobStatus.isRunning ? 'running' : 'completed',
    progress: {
      processedZipCodes: jobStatus.processedCount,
      totalZipCodes: jobStatus.totalCount,
      percentComplete: `${progress}%`,
      currentZip: jobStatus.currentZip,
      dealersFound: jobStatus.dealersFound,
      errors: jobStatus.errorCount,
      elapsedSeconds
    }
  })
})

app.get('/test', async (c) => {
  const startTime = Date.now();
  const testZipCodes = CA_ZIP_CODES.slice(0, 10); // Test with first 10 zip codes

  console.log('Starting TEST scraping...');
  console.log(`Testing with ${testZipCodes.length} zip codes: ${testZipCodes.join(', ')}`);

  const allDealers: DealerInfo[] = [];
  let processedCount = 0;
  let errorCount = 0;

  for (const zipCode of testZipCodes) {
    try {
      const dealers = await fetchDealersForZip(zipCode);

      if (dealers.length > 0) {
        allDealers.push(...dealers);
        console.log(`✓ Zip ${zipCode}: Found ${dealers.length} dealers`);
      } else {
        console.log(`  Zip ${zipCode}: No dealers found`);
      }

      processedCount++;
      await delay(10); 
    } catch (error) {
      errorCount++;
      console.error(`✗ Error processing zip ${zipCode}:`, error);
    }
  }

  console.log('\n🔄 Deduplicating dealers...');
  const uniqueDealers = deduplicateDealers(allDealers);

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  const summary = {
    status: 'test_complete',
    summary: {
      testZipCodes: testZipCodes,
      totalDealersFound: allDealers.length,
      uniqueDealers: uniqueDealers.length,
      duplicatesRemoved: allDealers.length - uniqueDealers.length,
      errorCount,
      durationSeconds: parseFloat(duration)
    },
    sampleDealers: uniqueDealers.slice(0, 3) // Show first 3 dealers as sample
  };

  console.log('\n✅ Test completed!');
  console.log(`📍 Total dealers found: ${allDealers.length}`);
  console.log(`✨ Unique dealers: ${uniqueDealers.length}`);
  console.log(`⏱️  Duration: ${duration}s\n`);

  return c.json(summary);
})

app.get('/start', async (c) => {
  // Check if a job is already running
  if (jobStatus.isRunning) {
    return c.json({
      status: 'already_running',
      message: 'A scraping job is already in progress. Check /status for details.',
      progress: {
        processedZipCodes: jobStatus.processedCount,
        totalZipCodes: jobStatus.totalCount,
        percentComplete: `${((jobStatus.processedCount / jobStatus.totalCount) * 100).toFixed(1)}%`
      }
    }, 409);
  }

  // Parse skip parameter (default: 1 = process all zips)
  const skipParam = c.req.query('skip');
  const skip = skipParam ? Math.max(1, parseInt(skipParam)) : 1;

  if (isNaN(skip)) {
    return c.json({ error: 'Invalid skip parameter. Must be a positive integer.' }, 400);
  }

  // Calculate how many zip codes will actually be processed
  const zipCodesToProcess = Math.ceil(CA_ZIP_CODES.length / skip);

  // Start the job in the background
  runScrapingJob(skip);

  // Return immediately with information about skip optimization
  return c.json({
    status: 'started',
    message: 'Scraping job started in the background',
    optimization: {
      skipInterval: skip,
      description: skip > 1
        ? `Processing every ${skip}${skip === 1 ? 'st' : skip === 2 ? 'nd' : skip === 3 ? 'rd' : 'th'} zip code to reduce duplicates (100-mile radius overlap)`
        : 'Processing all zip codes (no skipping)',
      totalZipCodesInCA: CA_ZIP_CODES.length,
      zipCodesToProcess: zipCodesToProcess,
      estimatedTimeSaved: skip > 1 ? `~${Math.floor((1 - 1/skip) * 100)}% faster` : 'none'
    },
    estimatedDurationMinutes: skip > 1 ? `${Math.ceil(10 / skip)}-${Math.ceil(15 / skip)}` : '10-15',
    checkStatusAt: '/status',
    outputFile: 'holosun-dealers-ca.csv',
    tip: skip === 1 ? '💡 TIP: Use ?skip=5 or ?skip=10 to reduce duplicates and save time!' : '✅ Using skip optimization to reduce processing time'
  });
})

// Background scraping job with incremental CSV writing
async function runScrapingJob(skip: number = 1) {
  const startTime = Date.now();
  const filename = 'holosun-dealers-ca.csv';

  // Select zip codes based on skip interval
  const selectedZipCodes = skip === 1
    ? CA_ZIP_CODES
    : CA_ZIP_CODES.filter((_, index) => index % skip === 0);

  // Reset and initialize job status
  jobStatus = {
    isRunning: true,
    startTime,
    processedCount: 0,
    totalCount: selectedZipCodes.length,
    dealersFound: 0,
    errorCount: 0,
    currentZip: 0
  };

  console.log('\n🚀 Starting California dealer scraping...');
  console.log(`📍 Skip interval: ${skip} (processing every ${skip}${skip === 1 ? 'st' : skip === 2 ? 'nd' : skip === 3 ? 'rd' : 'th'} zip code)`);
  console.log(`📍 Total zip codes to process: ${selectedZipCodes.length} of ${CA_ZIP_CODES.length}`);
  if (skip > 1) {
    console.log(`⚡ Time optimization: ~${Math.floor((1 - 1/skip) * 100)}% faster (reduces 100-mile radius overlap)`);
  }
  console.log(`📄 Output file: ${filename} (writing incrementally)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Track unique dealers using a Set of unique keys
  const seenDealers = new Set<string>();
  let totalDealersCollected = 0;
  let uniqueDealersWritten = 0;

  // Delete existing file if it exists
  try {
    await Bun.write(filename, '');
  } catch (error) {
    // File doesn't exist, that's fine
  }

  // Process each selected zip code
  for (const zipCode of selectedZipCodes) {
    jobStatus.currentZip = zipCode;

    try {
      const dealers = await fetchDealersForZip(zipCode);
      totalDealersCollected += dealers.length;

      if (dealers.length > 0) {
        // Filter out duplicates we've already seen
        const newDealers: DealerInfo[] = [];
        let duplicatesInBatch = 0;

        for (const dealer of dealers) {
          const key = `${(dealer.company_name || '').toLowerCase().trim()}-${(dealer.contact_addr || '').toLowerCase().trim()}`;

          if (!seenDealers.has(key)) {
            seenDealers.add(key);
            newDealers.push(dealer);
          } else {
            duplicatesInBatch++;
          }
        }

        // Write new unique dealers to CSV immediately
        if (newDealers.length > 0) {
          await appendToCSV(filename, newDealers);
          uniqueDealersWritten += newDealers.length;
        }

        jobStatus.dealersFound = uniqueDealersWritten;

        console.log(`✓ Zip ${zipCode}: Found ${dealers.length} dealers (${newDealers.length} new, ${duplicatesInBatch} duplicates)`);
      } else {
        console.log(`  Zip ${zipCode}: No dealers found`);
      }

      jobStatus.processedCount++;

      // Progress logging every 50 zip codes
      if (jobStatus.processedCount % 50 === 0) {
        const progress = ((jobStatus.processedCount / jobStatus.totalCount) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const dupeRate = ((totalDealersCollected - uniqueDealersWritten) / totalDealersCollected * 100).toFixed(1);

        console.log(`\n📊 Progress: ${jobStatus.processedCount}/${jobStatus.totalCount} (${progress}%)`);
        console.log(`   Total dealers collected: ${totalDealersCollected}`);
        console.log(`   Unique dealers written: ${uniqueDealersWritten}`);
        console.log(`   Duplication rate: ${dupeRate}%`);
        console.log(`   Elapsed time: ${elapsed} minutes\n`);
      }

      // Rate limiting: delay 150ms between requests
      await delay(150);
    } catch (error) {
      jobStatus.errorCount++;
      console.error(`✗ Error processing zip ${zipCode}:`, error);
    }
  }

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);
  const duplicatesRemoved = totalDealersCollected - uniqueDealersWritten;

  jobStatus.isRunning = false;

  console.log('\n✅ Scraping completed!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Total zip codes processed: ${jobStatus.processedCount}`);
  console.log(`📍 Total dealers collected: ${totalDealersCollected}`);
  console.log(`✨ Unique dealers written: ${uniqueDealersWritten}`);
  console.log(`🗑️  Duplicates removed: ${duplicatesRemoved}`);
  console.log(`❌ Errors: ${jobStatus.errorCount}`);
  console.log(`⏱️  Duration: ${duration} minutes`);
  console.log(`📄 Output file: ${filename}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

export default app
