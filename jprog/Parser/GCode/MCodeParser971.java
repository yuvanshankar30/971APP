package Parser.GCode;

public class MCodeParser971 implements GenericParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        int code;
        String tempCode = "";
        int indexOfM = gcodeLine.indexOf('M') + 1;
        while (!(indexOfM >= gcodeLine.length() || !(gcodeLine.charAt(indexOfM) != ' '))) {
            tempCode += gcodeLine.charAt(indexOfM);
            indexOfM++;
        }
        code = Integer.parseInt(tempCode);

        switch (code) {
            case 3, 4, 5 -> {
                int indexOfS = gcodeLine.indexOf('S') + 1;
                String speed = "";
                while (!(indexOfS >= gcodeLine.length() || !(gcodeLine.charAt(indexOfS) != ' '))) {
                    speed += gcodeLine.charAt(indexOfS);
                    indexOfS++;
                }
                doc.setSpindleSpeed(Integer.parseInt(speed));
                gcodeLine = gcodeLine.replaceAll("S\\s*\\d+", "").trim();
            } // spindle speed
            case 0,
                    1,
                    2,
                    30,
                    7,
                    9 ->
                {
                } // program pause)0 or 1), program end(2 or 30), mist or turned off(7 or
            // 9), tool change
            case 6 -> {
                gcodeLine = gcodeLine.replaceAll("T\\s*\\d+", "").trim();
                doc.changeTool(1);
            }
            case 8 -> throw new IllegalGCodeError("Flood Coolant is not supported @ line: " + lineNum);
            default ->
                throw new UnknownGCodeError("MCode : " + tempCode + " not parsable @ line: " + lineNum);
        }
        return gcodeLine.replace("M" + code, "");
    }
}
