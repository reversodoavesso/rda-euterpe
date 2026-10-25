import com.google.gson.*;
import com.spotify.playlist4.proto.Playlist4ApiProto;
import com.spotifyxp.spotapi.SpotAPI;
import com.spotifyxp.spotapi.pojos.LibraryTracksResponse;
import com.spotifyxp.spotapi.pojos.UserInfo;
import okhttp3.OkHttpClient;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Authenticated reads; credentials are supplied on stdin, never in arguments. */
public final class NtifyAccountRead {
    private static Map<String, Object> failure(String operation, Exception error) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operation", operation);
        result.put("status", "failed");
        result.put("error_type", error.getClass().getSimpleName());
        String message = String.valueOf(error.getMessage());
        for (String code : Arrays.asList("PersistedQueryNotFound", "HTTP 401", "HTTP 403", "HTTP 429")) {
            if (message.contains(code)) result.put("error_category", code);
        }
        return result;
    }

    public static void main(String[] args) throws Exception {
        Gson gson = new Gson();
        JsonObject input = JsonParser.parseString(new BufferedReader(new InputStreamReader(
            System.in, StandardCharsets.UTF_8)).readLine()).getAsJsonObject();
        OkHttpClient http = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS).build();
        SpotAPI api = new SpotAPI.Builder().setToken(input.get("access_token").getAsString())
            .setClientToken(input.get("client_token").getAsString())
            .setAppPlatform("WebPlayer").setUserAgent(input.get("user_agent").getAsString())
            .setSpotifyClientHost(input.get("spclient_host").getAsString())
            .setUserInfo(new UserInfo(input.get("username").getAsString(), "BR", "PREMIUM"))
            .setHttpClient(http).build();
        List<Map<String, Object>> cases = new ArrayList<>();
        try {
            Playlist4ApiProto.SelectedListContent root = api.playlist().rootlist()
                .setFrom(0).setLength(100).setDecorateAttributes(true).execute();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("operation", "rootlist");
            result.put("status", "passed");
            result.put("items_returned", root.getContents().getItemsCount());
            result.put("playlist_references", root.getContents().getItemsList().stream()
                .filter(item -> item.getUri().startsWith("spotify:playlist:")).count());
            result.put("has_revision", root.hasRevision());
            cases.add(result);
        } catch (Exception error) { cases.add(failure("rootlist", error)); }
        try {
            LibraryTracksResponse tracks = api.library().tracks().setLimit(1).setOffset(0).execute();
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("operation", "saved_tracks_first_page");
            result.put("status", tracks != null && tracks.getItems() != null ? "passed" : "failed");
            result.put("items_returned", tracks != null && tracks.getItems() != null ? tracks.getItems().size() : 0);
            cases.add(result);
        } catch (Exception error) { cases.add(failure("saved_tracks_first_page", error)); }
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("candidate", "ntify-spotapi");
        report.put("mode", "authenticated_read_with_desktop_access_token");
        report.put("mutations_performed", false);
        report.put("cases", cases);
        report.put("status", cases.stream().allMatch(item -> item.get("status").equals("passed")) ? "passed" : "partial_or_failed");
        System.out.println(gson.toJson(report));
    }
}
