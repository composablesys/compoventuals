#/usr/bin/bash

if [ -z "$4" ]
  then
    echo "Usage: ./todo_list.sh <out folder> <version> <warmup trials> <recorded trials> [--oursOnly | --theirsOnly]"
    echo "If --oursOnly is set, only our library's tests are run."
    echo "If --theirsOnly is set, only competitors' tests are run."
    exit 1
fi

if [ $3 == "0" ] && [ $4 == "0" ]
then
    echo "test run"
    set -e
fi

if [ ! -z $5 ] && [ $5 == "--oursOnly" ]
then
  names=("compoResetting" "compoDeleting" "compoJSON" "compoJSONText" "compoJSONOpt")
elif [ ! -z $5 ] && [ $5 == "--theirsOnly" ]
then
  names=("yjs" "automerge" "automergeNoText")
else
  names=("compoResetting" "compoDeleting" "compoJSON" "compoJSONText" "compoJSONOpt" "yjs" "automerge" "automergeNoText")
fi

for frequency in "whole"
do
    for measurement in "time" "network" "memory" "save"
    do
      for name in ${names[*]}
      do
          if [ $frequency == "rounds" ] && [ $measurement == "save" ] && [ $name == "compoJSON" ]
          then
            echo "Skipping todo_list compoJSON save rounds"
          else
            npm start -- $1 $2 $3 $4 "todo_list" $name $measurement $frequency
          fi
      done
    done
done
