package Parser.GCode;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CommentsParserWinCNC implements GenericParser {
    private static final Pattern TOOL_DEF_PATTERN = Pattern.compile("T(\\d+).*?D=([\\d.]+)");

    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        while (gcodeLine.contains("[")) {
            final int openIndex = gcodeLine.indexOf('[');

            // Find the matching closing bracket taking nesting into account
            int closeIndex = -1;
            int depth = 1;
            for (int i = openIndex + 1; i < gcodeLine.length(); i++) {
                char c = gcodeLine.charAt(i);
                if (c == '[') {
                    depth++;
                } else if (c == ']') {
                    depth--;
                    if (depth == 0) {
                        closeIndex = i;
                        break;
                    }
                }
            }

            if (closeIndex == -1) {
                // Skip the orphan '[' and continue searching
                gcodeLine = gcodeLine.substring(0, openIndex) + gcodeLine.substring(openIndex + 1);
                continue;
            }

            // Extract the content inside the bracket
            String content = gcodeLine.substring(openIndex + 1, closeIndex);

            // Check if this comment defines a tool
            Matcher m = TOOL_DEF_PATTERN.matcher(content);
            if (m.find()) {
                try {
                    int toolNum = Integer.parseInt(m.group(1));
                    double toolDia = Double.parseDouble(m.group(2));

                    // SAVE the tool definition to the library.
                    doc.defineTool(toolNum, toolDia);

                } catch (NumberFormatException e) {
                    System.err.println("Error parsing tool definition at line " + lineNum);
                }
            }

            // Remove the processed comment from the G-code line so it doesn't get
            // parsed again
            gcodeLine = gcodeLine.substring(0, openIndex) + gcodeLine.substring(closeIndex + 1);
        }
        return gcodeLine;
    }
}
