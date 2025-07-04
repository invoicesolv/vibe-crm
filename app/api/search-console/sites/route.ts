import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getRefreshedGoogleToken, handleTokenRefreshOnError } from '@/lib/token-refresh';

export const dynamic = 'force-dynamic';

interface SearchConsoleSite {
  url: string;
  permissionLevel: string;
}

// Helper function to get user from Supabase JWT token
async function getUserFromToken(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      return null;
    }
    return user;
  } catch (error) {
    console.error('Error verifying token:', error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    console.log('[Search Console Sites API] Starting GET request handler');
    
    // Get user from session
    const user = await getUserFromToken(request);

    if (!user) {
      console.error('[Search Console Sites API] Authentication error: No valid user');
      return NextResponse.json(
        { error: 'User not authenticated' },
        { status: 401 }
      );
    }

    console.log('[Search Console Sites API] Request received for user:', user.id);

    // Get the access token with proactive token refresh if needed
    const freshToken = await getRefreshedGoogleToken(user.id, 'google-searchconsole');
    
    // Get the current token from database
    const { data: integration, error: tokenError } = await supabaseAdmin
        .from('integrations')
        .select('access_token, refresh_token, expires_at')
        .eq('service_name', 'google-searchconsole')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1);
      
    if (tokenError || !integration || integration.length === 0) {
      console.error('[Search Console Sites API] No Search Console integration found:', tokenError);
      return NextResponse.json(
        { 
          error: 'Search Console integration not found',
          details: 'Please connect your Google Search Console account in settings',
          sites: []
        },
        { status: 400 }
      );
    }
    
    // Use the freshly refreshed token if available, otherwise use the stored token
    const accessToken = freshToken || integration[0].access_token;

    if (!accessToken) {
      console.error('[Search Console Sites API] No valid access token available');
      return NextResponse.json(
        { 
          error: 'Not authenticated with Search Console',
          details: 'No valid token found',
          sites: []
        },
        { status: 401 }
      );
    }

    try {
      console.log('[Search Console Sites API] Fetching all sites with accessToken');
      const sites = await fetchAllSearchConsoleSites(accessToken);
      
      console.log(`[Search Console Sites API] Successfully retrieved ${sites.length} sites`);
      
      return NextResponse.json({
        sites,
        total: sites.length,
        message: `Found ${sites.length} Search Console sites`
      });
    } catch (apiError: any) {
      // Try refreshing token on auth error and retry
      try {
        return await handleTokenRefreshOnError(
          apiError,
          user.id,
          'google-searchconsole',
          async (refreshedToken) => {
            console.log('[Search Console Sites API] Retrying with refreshed token');
            const sites = await fetchAllSearchConsoleSites(refreshedToken);
            
            return NextResponse.json({
              sites,
              total: sites.length,
              message: `Found ${sites.length} Search Console sites (with refreshed token)`
            });
          }
        );
      } catch (refreshError) {
        console.error('[Search Console Sites API] Error after token refresh attempt:', refreshError);
        return NextResponse.json(
          { 
            error: 'Failed to retrieve Search Console sites',
            details: (refreshError as Error).message || 'Unknown error',
            sites: []
          },
          { status: 500 }
        );
      }
    }
  } catch (error) {
    console.error('[Search Console Sites API] Unexpected error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        details: (error as Error).message || 'Unknown error',
        sites: []
      },
      { status: 500 }
    );
  }
}

async function fetchAllSearchConsoleSites(accessToken: string): Promise<SearchConsoleSite[]> {
  console.log('[Search Console Sites API] Fetching all sites from Google Search Console API');
  
  const response = await fetch(
    'https://www.googleapis.com/webmasters/v3/sites',
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Search Console Sites API] Failed to fetch Search Console sites:', {
      status: response.status,
      statusText: response.statusText,
      error: errorText
    });
    throw new Error(`Failed to fetch sites: ${response.statusText}`);
  }

  const sitesData = await response.json();
  const sites = sitesData.siteEntry?.map((site: any) => ({
    url: site.siteUrl,
    permissionLevel: site.permissionLevel || 'unknown'
  })) || [];

  console.log(`[Search Console Sites API] Successfully fetched ${sites.length} sites:`, 
    sites.map(s => ({ url: s.url, permission: s.permissionLevel }))
  );

  return sites;
} 